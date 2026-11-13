"""Release a dead Strata SSH forward so the Windows supervisor can reconnect."""
import http.client
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import time

IDLE_MS = 30000
PROBE_INTERVAL = 7


def sockets(*args):
    return subprocess.check_output(["/usr/bin/ss", "-H", *args], text=True, timeout=5)


def listener():
    rows = sockets("-lntp", "sport = :18080").splitlines()
    if len(rows) != 1 or rows[0].split()[3] != "127.0.0.1:18080":
        return None
    owners = re.findall(r'\("([^"]+)",pid=(\d+),', rows[0])
    if len(owners) == 1 and owners[0][0] == "sshd":
        return int(owners[0][1])
    return None


def idle_transport(pid):
    # TCP ACKs can still arrive from an SSH client that cannot process a
    # forwarded request. Count received payload bytes on the same socket.
    lines = sockets("-tinep", "state", "established", "sport = :22").splitlines()
    for header, details in zip(lines, lines[1:]):
        if f'"sshd",pid={pid},' not in header:
            continue
        inode = re.search(r"\bino:(\d+)\b", header)
        metrics = dict(re.findall(r"\b(lastrcv|bytes_received):(\d+)\b", details))
        if inode and "bytes_received" in metrics and int(metrics.get("lastrcv", 0)) >= IDLE_MS:
            return inode[1], metrics["bytes_received"]
    return None


def failed_probe():
    # Any HTTP response proves that the loopback gateway is reachable.
    conn = http.client.HTTPConnection("127.0.0.1", 18080, timeout=3)
    try:
        conn.request("GET", "/v1/models")
        conn.getresponse()
        return False
    except (OSError, http.client.HTTPException):
        return True
    finally:
        conn.close()


def main():
    pid = listener()
    if pid is None:
        return
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        uid = pwd.getpwnam("strata-tunnel").pw_uid
        status = Path(f"/proc/{pid}/status").read_text()
        if not re.search(rf"^Uid:\s+{uid}\s+{uid}\s", status, re.M):
            return
        original = idle_transport(pid)
        if original is None:
            return
        for attempt in range(3):
            if listener() != pid or not failed_probe():
                return
            # Even a refused connection at the Windows gateway normally
            # produces an SSH channel-open failure and advances this counter.
            if listener() != pid or idle_transport(pid) != original:
                return
            if attempt < 2:
                time.sleep(PROBE_INTERVAL)
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        print(f"Released unresponsive Strata reverse tunnel (sshd PID {pid}, three unanswered probes)")
    except (FileNotFoundError, ProcessLookupError):
        pass  # The supervisor or sshd recovered before we needed to act.
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
