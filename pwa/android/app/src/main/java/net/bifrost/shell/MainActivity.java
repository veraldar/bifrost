package net.bifrost.shell;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * bifrost shell — the minimal Android wrap of the bifrost PWA.
 *
 * What it adds over Chrome: the APP holds RECORD_AUDIO and grants WebView audio
 * capture to the paired origin only; a native notification bridge
 * (BifrostNative.notify); and the pairing deep link
 * bifrost://pair?token=RAW&url=PWA_ORIGIN[&bridge=BRIDGE_URL], verified natively
 * against the bridge's /offer (401 = token refused, anything else = accepted).
 * The token is handed to the PWA through its own contract (localStorage
 * bifrost_device / bifrost_bridge — pwa/app/pair, pwa/app/bridge).
 *
 * Every lifecycle step logs one greppable logcat line (tag BifrostShell,
 * prefix BIFROST_) — the ygg-sim app.* scenarios assert on them.
 */
public class MainActivity extends Activity {
    static final String TAG = "BifrostShell";
    static final String VERSION = "0.1.0"; // keep in sync with build.sh VERSION_NAME
    static final int REQ_MIC = 7;
    static final String CHANNEL = "replies";

    private WebView web;
    private SharedPreferences prefs;
    private PermissionRequest pendingPerm;
    private volatile String currentUrl = "";
    private int notifyId = 100;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("bifrost", MODE_PRIVATE);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " BifrostShell/" + VERSION);
        web.addJavascriptInterface(new NativeBridge(), "BifrostNative");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                runOnUiThread(() -> handlePermission(req));
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, "console: " + m.message());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String u = r.getUrl().toString();
                if (sameOrigin(u, pairedUrl())) return false;
                // anything off the paired origin leaves the shell (no mic, no bridge)
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl()));
                } catch (Exception e) {
                    Log.w(TAG, "BIFROST_NAV external failed " + e);
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) {
                currentUrl = url;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                currentUrl = url;
                Log.i(TAG, "BIFROST_PAGE loaded " + url);
                injectPairing(url);
            }
        });

        ensureChannel();
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handleIntent(i);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // deliberately NOT web.onPause(): the page keeps running while the
        // activity is not visible (screen off). The OS may still silence the
        // mic of a backgrounded app — that is what app.background-audio
        // measures, and what a microphone foreground service would fix.
        Log.i(TAG, "BIFROST_LIFECYCLE pause");
    }

    @Override
    protected void onStop() {
        super.onStop();
        Log.i(TAG, "BIFROST_LIFECYCLE stop");
    }

    @Override
    protected void onResume() {
        super.onResume();
        Log.i(TAG, "BIFROST_LIFECYCLE resume");
    }

    private String pairedUrl() {
        return prefs.getString("url", "");
    }

    private void handleIntent(Intent i) {
        Uri d = i == null ? null : i.getData();
        if (d != null && "bifrost".equals(d.getScheme())) {
            String host = d.getHost();
            if ("pair".equals(host)) {
                pair(d);
                return;
            }
            if ("open".equals(host)) {
                String u = d.getQueryParameter("url");
                if (u != null && sameOrigin(u, pairedUrl())) {
                    Log.i(TAG, "BIFROST_OPEN " + u);
                    web.loadUrl(u);
                } else {
                    Log.w(TAG, "BIFROST_OPEN refused (not the paired origin)");
                }
                return;
            }
        }
        String url = pairedUrl();
        if (url.isEmpty()) {
            Log.i(TAG, "BIFROST_START unpaired");
            web.loadData("<html><body style='font-family:sans-serif;background:#14161c;color:#ddd;padding:24px'>"
                    + "<h2>bifrost</h2><p>Not paired. Open the pairing link (bifrost://pair?...) "
                    + "from your bifrost's /pair page.</p></body></html>", "text/html", "utf-8");
        } else {
            Log.i(TAG, "BIFROST_START " + url);
            web.loadUrl(url);
        }
    }

    private void pair(Uri d) {
        String token = d.getQueryParameter("token");
        String url = d.getQueryParameter("url");
        String bridge = d.getQueryParameter("bridge");
        if (token == null || token.isEmpty() || url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            Log.w(TAG, "BIFROST_PAIR rejected (token + http(s) url required)");
            return;
        }
        if (bridge == null || bridge.isEmpty()) bridge = url;
        prefs.edit().putString("token", token).putString("url", url).putString("bridge", bridge)
                .remove("verified").apply();
        Log.i(TAG, "BIFROST_PAIR saved origin=" + origin(url) + " bridge=" + origin(bridge));
        requestRuntimePermissions();
        final String b = bridge;
        new Thread(() -> verify(b, token), "bifrost-verify").start();
        web.loadUrl(url);
    }

    /** POST {bridge}/offer with the Bearer token: 401 = refused, else accepted. */
    private void verify(String bridge, String token) {
        int code = -1;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(bridge.replaceAll("/+$", "") + "/offer").openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) {
                o.write("{}".getBytes(StandardCharsets.UTF_8));
            }
            code = c.getResponseCode();
            c.disconnect();
        } catch (Exception e) {
            Log.w(TAG, "BIFROST_PAIR verify error " + e);
        }
        prefs.edit().putInt("verified", code).apply();
        // the bridge answers a bodyless offer with 400 (bad SDP) once the token
        // passes, 401 when it does not — anything else is not a bridge
        String verdict = (code == 401 || code == 403) ? " (token refused)"
                : (code == 400 || code == 200) ? " (token accepted)" : " (unexpected)";
        Log.i(TAG, "BIFROST_PAIR verify status=" + code + verdict);
    }

    private void injectPairing(String url) {
        String token = prefs.getString("token", "");
        if (token.isEmpty() || !sameOrigin(url, pairedUrl())) return;
        String js = "try{localStorage.setItem('bifrost_device'," + JSONObject.quote(token)
                + ");localStorage.setItem('bifrost_bridge'," + JSONObject.quote(prefs.getString("bridge", ""))
                + ");window.dispatchEvent(new Event('bifrost-paired'));}catch(e){}";
        web.evaluateJavascript(js, null);
    }

    private void handlePermission(PermissionRequest req) {
        String o = req.getOrigin().toString();
        boolean audioOnly = true;
        for (String r : req.getResources()) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audioOnly = false;
        }
        if (!sameOrigin(o, pairedUrl()) || !audioOnly) {
            Log.w(TAG, "BIFROST_MIC deny origin=" + origin(o) + " audioOnly=" + audioOnly);
            req.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "BIFROST_MIC grant origin=" + origin(o));
            req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingPerm = req;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    private void requestRuntimePermissions() {
        java.util.ArrayList<String> want = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            want.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!want.isEmpty()) requestPermissions(want.toArray(new String[0]), REQ_MIC + 1);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_MIC || pendingPerm == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        Log.i(TAG, "BIFROST_MIC runtime " + (ok ? "granted" : "denied"));
        if (ok) pendingPerm.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else pendingPerm.deny();
        pendingPerm = null;
    }

    private void ensureChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Replies", NotificationManager.IMPORTANCE_HIGH));
        }
    }

    static String origin(String u) {
        try {
            Uri x = Uri.parse(u);
            int port = x.getPort();
            if (port == -1) port = "https".equals(x.getScheme()) ? 443 : "http".equals(x.getScheme()) ? 80 : -1;
            return x.getScheme() + "://" + x.getHost() + ":" + port;
        } catch (Exception e) {
            return "?";
        }
    }

    static boolean sameOrigin(String a, String b) {
        if (a == null || b == null || a.isEmpty() || b.isEmpty()) return false;
        return origin(a).equals(origin(b));
    }

    /** window.BifrostNative — callable only while the paired origin is loaded. */
    class NativeBridge {
        private boolean allowed() {
            return sameOrigin(currentUrl, pairedUrl());
        }

        @JavascriptInterface
        public String version() {
            return VERSION;
        }

        @JavascriptInterface
        public boolean paired() {
            return allowed() && !prefs.getString("token", "").isEmpty();
        }

        @JavascriptInterface
        public boolean notify(String title, String body) {
            if (!allowed()) {
                Log.w(TAG, "BIFROST_NOTIFY refused (origin)");
                return false;
            }
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "BIFROST_NOTIFY no POST_NOTIFICATIONS permission");
                return false;
            }
            Notification n = new Notification.Builder(MainActivity.this, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true)
                    .build();
            getSystemService(NotificationManager.class).notify(notifyId++, n);
            Log.i(TAG, "BIFROST_NOTIFY posted " + body);
            return true;
        }
    }
}
