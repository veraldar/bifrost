package org.veraldar.bifrost;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Bridge;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;

public class MainActivity extends BridgeActivity {

  // Fleet telemetry (hard requirement): native-layer errors route into the
  // same .diag pipeline the web layer uses (/api/diag on the loaded origin).
  private static final java.util.concurrent.atomic.AtomicReference<String> DIAG_BASE =
      new java.util.concurrent.atomic.AtomicReference<>("");
  private final AtomicBoolean anrSuspected = new AtomicBoolean(false);

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    resolveDiagBase();
    installCrashHandler();
    installAnrWatchdog();
    injectLabMic();
  }

  /** The loaded origin (capacitor.config server.url) is where /api/diag lives. */
  private void resolveDiagBase() {
    new Thread(() -> {
      try {
        java.io.InputStream is = getAssets().open("capacitor.config.json");
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        is.close();
        JSONObject cfg = new JSONObject(bo.toString("UTF-8"));
        String url = cfg.getJSONObject("server").getString("url");
        if (url != null && url.endsWith("/")) url = url.substring(0, url.length() - 1);
        DIAG_BASE.set(url);
      } catch (Exception e) {
        android.util.Log.w("BifrostDiag", "diag base unresolved: " + e);
      }
    }).start();
  }


  /** LAB FEATURE (lab builds only): inject USER-AGI's looping wav as the mic,
   *  so the full hands-free loop simulates on a headless emulator. The
   *  production phones use their real microphones and never see this. */
  private void injectLabMic() {
    final String js =
      "(async () => {"
    + "  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);"
    + "  navigator.mediaDevices.getUserMedia = async (c) => {"
    + "    if (!c || !c.audio) return orig(c);"
    + "    const ac = new (window.AudioContext || window.webkitAudioContext)();"
    + "    const buf = await ac.decodeAudioData(await (await fetch('/user-agi.wav')).arrayBuffer());"
    + "    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;"
    + "    const dst = ac.createMediaStreamDestination(); src.connect(dst); src.start();"
    + "    return dst.stream;"
    + "  };"
    + "})();";
    try {
      Bridge bridge = getBridge();
      if (bridge != null && bridge.getWebView() != null) {
        bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
      }
    } catch (Exception e) {
      android.util.Log.w("BifrostDiag", "lab mic injection failed: " + e);
    }
  }

  private void installCrashHandler() {
    final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
      try {
        java.io.StringWriter sw = new java.io.StringWriter();
        throwable.printStackTrace(new java.io.PrintWriter(sw));
        postDiag("native-crash", thread.getName() + ": " + throwable + "\n"
            + sw.toString().substring(0, Math.min(sw.toString().length(), 3000)));
      } catch (Exception ignore) {
        // never let telemetry break the crash path
      }
      if (prev != null) prev.uncaughtException(thread, throwable);
    });
  }

  /** ANR suspect: the main thread unresponsive for >5s while the app is up. */
  private void installAnrWatchdog() {
    final Handler main = new Handler(Looper.getMainLooper());
    Thread t = new Thread(() -> {
      while (true) {
        anrSuspected.set(false);
        main.postDelayed(() -> anrSuspected.set(true), 5000);
        try { Thread.sleep(6000); } catch (InterruptedException e) { return; }
        if (anrSuspected.get()) {
          postDiag("native-anr", "main thread unresponsive >5s (watchdog)");
        }
      }
    }, "BifrostAnrWatch");
    t.setDaemon(true);
    t.start();
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    for (int i = 0; i < permissions.length; i++) {
      if (grantResults[i] != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        postDiag("native-permission-denied", permissions[i]);
      }
    }
  }

  private void postDiag(String kind, String msg) {
    final String base = DIAG_BASE.get();
    if (base == null || base.isEmpty()) return;
    final String payload;
    try {
      payload = new JSONObject()
          .put("client", "android-native")
          .put("page", "app")
          .put("reason", kind)
          .put("events", new org.json.JSONArray()
              .put(new JSONObject()
                  .put("t", System.currentTimeMillis())
                  .put("kind", kind)
                  .put("msg", msg)))
          .toString();
    } catch (Exception e) {
      return;
    }
    Thread t = new Thread(() -> {
      try {
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/diag").openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("content-type", "application/json");
        c.setDoOutput(true);
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        OutputStream os = c.getOutputStream();
        os.write(payload.getBytes(StandardCharsets.UTF_8));
        os.close();
        c.getResponseCode();
        c.disconnect();
      } catch (Exception ignore) {
        // best-effort: the fleet loop reads what arrives
      }
    }, "BifrostDiagPost");
    t.setDaemon(true);
    t.start();
  }
}
