# A fresh Debian 12 "VPS": systemd as PID 1 (like any rented server), sshd-less, nothing of ours.
# trunk.sh installs everything else it needs (curl, openssl, libopus0, certbot, …) with apt itself.
FROM debian:12
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus iproute2 procps \
      ca-certificates sudo >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty@tty1.service serial-getty@ttyS0.service systemd-firstboot.service >/dev/null 2>&1 || true
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
