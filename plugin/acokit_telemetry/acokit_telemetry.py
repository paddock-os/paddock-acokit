"""
acokit_telemetry — Assetto Corsa in-game Python plugin (AC Overlay Kit).

Reads telemetry of the FOCUSED car (the one the director is currently
spectating) using AC's in-game Python API and POSTs it to the acokit
coordinator at http://127.0.0.1:3001 at ~30Hz.

WHY AN IN-GAME PLUGIN INSTEAD OF THE EXTERNAL SHARED-MEMORY READER?
The acpmf_* shared memory blocks only contain the LOCAL player car. In
multiplayer spectator mode the director has no car of their own, so the
shared memory contains a phantom with all values at 0. The only reliable
way to read the FOCUSED car's telemetry is the in-game Python API:

    ac.getFocusedCar()                          → carId of focused car
    ac.getCarState(carId, acsys.CS.Gas)         → throttle 0..1
    ac.getCarState(carId, acsys.CS.Brake)       → brake 0..1
    ac.getCarState(carId, acsys.CS.Clutch)      → clutch 0..1
    ac.getCarState(carId, acsys.CS.Gear)        → gear (0=R, 1=N, 2=1st, ...)
    ...

Same data path the in-game "Pedals" app uses. Works in single-player,
replay AND multiplayer spectator mode.

INSTALLATION
    1. Copy this entire folder to your Assetto Corsa install:
       <Steam>/steamapps/common/assettocorsa/apps/python/acokit_telemetry/
       so the final path is:
       <AC>/apps/python/acokit_telemetry/acokit_telemetry.py

    2. Launch AC. Go to Settings → General → UI Modules.
       Tick "acokit_telemetry" and Apply (restart AC if it doesn't appear).

    3. Make sure an acokit coordinator is running on 127.0.0.1:3001.

    4. The plugin window is invisible — there's nothing to see in AC.
       To verify it's loaded, open the AC console (Page Up by default
       or "console" in the AC main menu) and look for:
           [acokit] Plugin loaded. Posting to 127.0.0.1:3001

NOTES
    - AC ships an embedded Python 3.3.5. This plugin uses socket, json,
      traceback, plus mmap + struct for the session flag (all stdlib).
      mmap/struct are imported defensively — if a build lacks them the
      plugin still runs, it just won't report flags. No pip, no deps.
    - urllib in AC's Python is historically buggy, so we send HTTP via
      a hand-built request over a raw TCP socket. HTTP/1.0 with
      Connection: close keeps it minimal.
    - Each POST is synchronous but the network call is localhost
      (~0.5-1ms). At 30Hz that costs ~3% of frame time. If you see
      stutter, lower TELEMETRY_INTERVAL_S below.
"""

# ─── Make AC's stripped Python find the socket C-extension ──────────────────
# AC's embedded Python 3.3.5 ships WITHOUT the _socket extension on the default
# plugin sys.path, so a plain `import socket` dies with
# "ImportError: No module named '_socket'". The standard AC-plugin fix (used by
# acti, RealPenalty, helicorsa, ...) is to bundle the compiled _socket.pyd
# (+ select.pyd) under stdlib/ (32-bit) and stdlib64/ (64-bit) inside the app
# folder and prepend the right one to sys.path. Modern AC runs x64. This MUST
# run before `import socket`.
import sys
import os
_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_LIBDIR = "stdlib64" if sys.maxsize > 2 ** 32 else "stdlib"
_lib_path = os.path.join(_APP_DIR, _LIBDIR)
if os.path.isdir(_lib_path) and _lib_path not in sys.path:
    sys.path.insert(0, _lib_path)

import socket
import time
import json
import traceback
import base64
import hashlib


import ac
import acsys

# mmap/struct are used to read AC's acpmf_graphics shared memory for the
# session-wide race-control flag. Treated as optional: if this AC build's
# embedded Python lacks either module the plugin still runs, it just won't
# report flags (sessionFlag stays "none").
try:
    import mmap
    import struct
    _SHM_AVAILABLE = True
except Exception:
    _SHM_AVAILABLE = False


# ─── Configuration ──────────────────────────────────────────────────────────
# Sent in the fleet handshake so the coordinator can log which build a
# driver is running — eighteen machines drift, and "which version are you
# on" is the first question when one of them misbehaves.
PLUGIN_VERSION = "0.3.0"
COORDINATOR_HOST = "127.0.0.1"
COORDINATOR_PORT = 3001
TELEMETRY_INTERVAL_S = 1.0 / 30  # 30Hz fast telemetry
STATE_INTERVAL_S = 1.0           # 1Hz slow plugin state

# ─── Shared memory: session flag ────────────────────────────────────────────
# WHY THIS BLOCK IS SAFE TO READ IN SPECTATOR MODE
# The acpmf_PHYSICS block only holds the LOCAL car (a phantom of zeros for a
# spectating director) — that's why this plugin reads telemetry via the
# in-game API instead. But acpmf_GRAPHICS is different: its `flag` field is
# the race-control flag the *client itself* sees, which is session-wide. So
# the director's client shows the global yellow flag even with no car.
#
# Field offset: SPageFileGraphics places AC_FLAG_TYPE `flag` at byte 1222.
# Layout up to that point (wchar_t = 2 bytes on Windows):
#   packetId(4) status(4) session(4) currentTime[15](30) lastTime[15](30)
#   bestTime[15](30) split[15](30) completedLaps(4) position(4)
#   iCurrentTime(4) iLastTime(4) iBestTime(4) sessionTimeLeft(4)
#   distanceTraveled(4) isInPit(4) currentSectorIndex(4) lastSectorTime(4)
#   numberOfLaps(4) tyreCompound[33](66) replayTimeMultiplier(4)
#   normalizedCarPosition(4) activeCars(4) carCoordinates[60][3](720)
#   carID[60](240) playerCarID(4) penaltyTime(4) → flag @ 1222
GRAPHICS_SHM_NAME = "Local\\acpmf_graphics"
GRAPHICS_SHM_SIZE = 2048
G_FLAG_OFFSET = 1222  # AC_FLAG_TYPE flag (int)

# Timing fields in the SAME SPageFileGraphics block. AC fills these for the
# car the client is watching — and crucially they WORK IN REPLAY where the
# acsys.CS.LastLap / BestLap / LapCount calls return 0. Offsets derived from
# the layout above (and cross-checked against the known flag @ 1222):
#   completedLaps @132  iCurrentTime @140  iLastTime @144  iBestTime @148
#   currentSectorIndex @164  lastSectorTime @168
G_COMPLETED_LAPS_OFFSET = 132
G_ICURRENT_OFFSET = 140
G_ILAST_OFFSET = 144
G_IBEST_OFFSET = 148
G_CUR_SECTOR_OFFSET = 164
G_LAST_SECTOR_OFFSET = 168

# AC_FLAG_TYPE enum → overlay-friendly string.
FLAG_NAMES = {
    0: "none",
    1: "blue",
    2: "yellow",
    3: "black",
    4: "white",
    5: "checkered",
    6: "penalty",
}


# ─── Module-level state ─────────────────────────────────────────────────────
telemetry_accum = 0.0
state_accum = 0.0
app_window = None
graphics_shm = None       # mmap handle for acpmf_graphics, or None
shm_warned = False        # one-shot logging flag for shared-memory failures
_post_blocked = False     # True → coordinator is down; skip ALL socket I/O
_fleet_accum = 0.0        # seconds since the last fleet send
_state_retry_count = 0    # 1Hz ticks to wait before the next health check

# Per-frame lap-completion detection for the FOCUSED car. AC's acsys LastLap /
# BestLap / LapCount return 0 in replay, and acpmf_graphics reflects the local
# player car (not the spectated one), so neither gives the focused car's lap
# total. Instead we watch acsys LapTime (which DOES work for the focused car)
# every frame and, when it resets at the start/finish line, reconstruct the
# EXACT lap time:  total = prevLapTime - curLapTime + frameDelta.
prev_lap_time_ms = 0          # focused car's LapTime on the previous frame
prev_focused_for_lap = -1     # focused car id the above belongs to
last_completed_lap_ms = 0     # most recent completed lap (exact), ms
lap_event_counter = 0         # bumped each completion so overlays detect it


# ─── Fleet mode: one WebSocket to the league coordinator ────────────────────
# The HTTP path above posts to a coordinator on THIS machine. Fleet mode is the
# other shape: every driver's AC connects to the league's public coordinator and
# sends their own car, so the broadcast can cut to anyone without the director
# needing AC open at all.
#
# There is no WebSocket library in AC's embedded Python 3.3.5, so this is a
# hand-rolled client: HTTP upgrade, then RFC 6455 frames. Two rules matter and
# both are easy to get wrong —
#   * every client→server frame MUST be masked, or the server closes on us;
#   * the socket MUST be non-blocking, because this runs on AC's render thread
#     and a blocking send during a network hiccup is dropped frames.
#
# Configure per driver:
#   FLEET_URL    ws://host/api/plugin/ws  (or wss:// — see the note there)
#   FLEET_TOKEN  the league token
FLEET_URL = ""            # empty = fleet mode off, keep posting over HTTP
FLEET_TOKEN = ""
FLEET_MODE = "driver"     # "driver" = send MY car; "director" = send the focused one

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"   # RFC 6455 handshake constant
WS_RECONNECT_S = 5.0
WS_SEND_BUDGET = 64        # frames buffered before we start dropping

# playerCarID lives in the same acpmf_graphics block as the flag. The layout
# comment above ends: carID[60](240) playerCarID(4) penaltyTime(4) flag@1222,
# so playerCarID sits 8 bytes before the flag.
G_PLAYER_CAR_ID_OFFSET = G_FLAG_OFFSET - 8


class _WsClient(object):
    """Minimal, non-blocking WebSocket client. Text frames out, text frames in."""

    def __init__(self, url, on_message):
        self.url = url
        self.on_message = on_message
        self.sock = None
        self.state = "idle"        # idle | connecting | open | failed
        self.next_attempt = 0.0
        self._rx = b""
        self._tx = []
        self._handshake_sent = False
        self._parse_url(url)

    def _parse_url(self, url):
        secure = url.startswith("wss://")
        rest = url.split("://", 1)[1] if "://" in url else url
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.secure = secure
        self.host = host
        self.port = int(port) if port else (443 if secure else 80)
        self.path = "/" + path if path else "/"

    # ── connection ──────────────────────────────────────────────────────────
    def connect(self, now):
        if self.state in ("connecting", "open"):
            return
        if now < self.next_attempt:
            return
        self.next_attempt = now + WS_RECONNECT_S
        # ws:// only, deliberately. A TLS handshake on a NON-BLOCKING socket
        # inside AC's Python 3.3.5 means driving do_handshake() through
        # retries with no usable certificate store — a lot of fragile code
        # running on the render thread of eighteen strangers' PCs. Failing
        # here with a sentence beats failing at handshake time with none.
        if self.secure:
            ac.console("[acokit] wss:// is not supported by this plugin. Point FLEET_URL at ws:// — see docs/FLEET.md in the acokit repository for what that means for the token.")
            self.state = "failed"
            return
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setblocking(False)
            try:
                sock.connect((self.host.encode("ascii"), self.port))
            except Exception:
                pass                      # non-blocking connect: EINPROGRESS
            self.sock = sock
            self.state = "connecting"
            self._rx = b""
            self._tx = []
            self._handshake_sent = False
        except Exception:
            self.state = "idle"
            self.sock = None

    def _send_handshake(self):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self._accept_expected = base64.b64encode(
            hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")
        req = (
            "GET " + self.path + " HTTP/1.1\r\n"
            "Host: " + self.host + ":" + str(self.port) + "\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: " + key + "\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).encode("ascii")
        self.sock.sendall(req)
        self._handshake_sent = True

    def _read_available(self):
        try:
            while True:
                chunk = self.sock.recv(4096)
                if not chunk:
                    self.close()
                    return
                self._rx += chunk
        except Exception:
            return                        # EWOULDBLOCK, or a real error we treat as one

    # ── framing ─────────────────────────────────────────────────────────────
    def _frame(self, payload, opcode=0x1):
        """Build a masked client frame. Masking is mandatory for clients."""
        data = payload.encode("utf-8") if isinstance(payload, str) else payload
        header = bytearray()
        header.append(0x80 | opcode)      # FIN + opcode
        n = len(data)
        if n < 126:
            header.append(0x80 | n)       # MASK bit + length
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytearray(data)
        for i in range(len(masked)):
            masked[i] ^= mask[i % 4]
        return bytes(header) + bytes(masked)

    def _drain(self):
        while self._tx:
            try:
                self.sock.sendall(self._tx[0])
                self._tx.pop(0)
            except Exception:
                return                    # would block; try again next frame

    def _consume_frames(self):
        while len(self._rx) >= 2:
            b0 = self._rx[0]
            b1 = self._rx[1]
            opcode = b0 & 0x0F
            length = b1 & 0x7F
            offset = 2
            if length == 126:
                if len(self._rx) < 4:
                    return
                length = struct.unpack(">H", self._rx[2:4])[0]
                offset = 4
            elif length == 127:
                if len(self._rx) < 10:
                    return
                length = struct.unpack(">Q", self._rx[2:10])[0]
                offset = 10
            if len(self._rx) < offset + length:
                return
            payload = self._rx[offset:offset + length]
            self._rx = self._rx[offset + length:]
            if opcode == 0x8:                       # close
                self.close()
                return
            elif opcode == 0x9:                     # ping -> pong, or the server drops us
                self._tx.append(self._frame(payload, 0xA))
            elif opcode == 0x1:
                try:
                    self.on_message(json.loads(payload.decode("utf-8")))
                except Exception:
                    pass

    # ── pumped once per frame from acUpdate ─────────────────────────────────
    def pump(self, now):
        if self.state == "failed":
            return
        if self.state == "idle":
            self.connect(now)
            return
        if self.sock is None:
            self.state = "idle"
            return
        try:
            if self.state == "connecting":
                if not self._handshake_sent:
                    try:
                        self._send_handshake()
                    except Exception:
                        return            # socket not writable yet; retry next frame
                self._read_available()
                if b"\r\n\r\n" in self._rx:
                    head, _, rest = self._rx.partition(b"\r\n\r\n")
                    self._rx = rest
                    text = head.decode("ascii", "ignore")
                    if "101" in text.split("\r\n")[0]:
                        self.state = "open"
                        ac.console("[acokit] fleet link open to " + self.host)
                    else:
                        ac.console("[acokit] fleet link refused: " + text.split("\r\n")[0])
                        self.close()
                return
            self._read_available()
            self._consume_frames()
            self._drain()
        except Exception:
            self.close()

    def send_json(self, obj):
        if self.state != "open":
            return False
        if len(self._tx) > WS_SEND_BUDGET:
            return False                  # network is behind; drop rather than grow
        try:
            self._tx.append(self._frame(json.dumps(obj)))
        except Exception:
            return False
        self._drain()
        return True

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None
        self.state = "idle"
        self._rx = b""
        self._tx = []
        self._handshake_sent = False


_ws = None                 # the client, when fleet mode is on
_ws_hz = 2.0               # send rate the server asked for
_ws_hello_sent = False


def _on_ws_message(msg):
    """Server → plugin: welcome, rate changes, refusals."""
    global _ws_hz, _ws_hello_sent
    kind = msg.get("type")
    if kind == "welcome":
        _ws_hz = float(msg.get("hz") or 2)
        ac.console("[acokit] fleet: accepted as " + str(msg.get("id")) +
                   (" (ON CAMERA)" if msg.get("selected") else "") + " at " + str(_ws_hz) + "Hz")
    elif kind == "rate":
        _ws_hz = float(msg.get("hz") or 2)
        if msg.get("selected"):
            ac.console("[acokit] fleet: you are ON CAMERA — sending at " + str(_ws_hz) + "Hz")
    elif kind == "denied":
        _ws_hello_sent = False
        ac.console("[acokit] fleet refused: " + str(msg.get("reason")))


def safe_driver_name(car_id):
    """The name AC reports for a car. This is the identity the league
    coordinator checks against its roster — AC's Python API exposes no
    SteamID, so the name is all there is."""
    try:
        return (ac.getDriverName(int(car_id)) or "").strip()
    except Exception:
        return ""


def _player_car_id():
    """The car THIS machine is driving, which is not always the focused one.

    A driver watching a replay or a trackside camera still has to send their
    own car, so fleet mode reads playerCarID out of the graphics block rather
    than trusting the camera.
    """
    shm = _ensure_graphics_shm()
    if shm is not None:
        try:
            v = _g_int(shm, G_PLAYER_CAR_ID_OFFSET)
            if v is not None and v >= 0:
                return v
        except Exception:
            pass
    try:
        return ac.getFocusedCar()
    except Exception:
        return 0


# ─── HTTP POST (raw socket; AC Python's urllib is unreliable) ───────────────
# STRATEGY — this runs on AC's RENDER THREAD, so a blocking socket is frames on
# the floor. When the coordinator is unreachable we therefore disable ALL socket
# I/O on the hot 30Hz path and let the 1Hz state POST act as a periodic health
# check, with a bare-minimum connect timeout so even that cannot stall the game.
#
# Without this gating, a coordinator that is down (or worse, hung — accepting
# the connection but never reading) costs 30 × the timeout every second. At the
# old 200ms that was six seconds of blocking per second of wall clock: AC simply
# freezes. The content layer learned this in production; the engine keeps it.
POST_TIMEOUT_S = 0.02     # socket connect timeout — bare minimum
STATE_RETRY_TICKS = 10    # ~10s between health checks while blocked


def _raw_post(path, data, timeout=POST_TIMEOUT_S):
    """Low-level POST. Always attempts the connection, regardless of the gate.
    Returns True on success, False on failure."""
    try:
        body = json.dumps(data).encode("utf-8")
        request = (
            "POST " + path + " HTTP/1.0\r\n"
            "Host: " + COORDINATOR_HOST + ":" + str(COORDINATOR_PORT) + "\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: " + str(len(body)) + "\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode("utf-8") + body

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            # Pass the host as BYTES, never str. AC's embedded Python 3.3.5
            # ships without the `idna` text codec, and socket.connect() runs a
            # str host through idna encoding first — which raises
            # LookupError('unknown encoding: idna') on this build (the same
            # error other AC plugins log every few seconds). A bytes host is
            # used verbatim by the socket layer and skips the idna path.
            sock.connect((COORDINATOR_HOST.encode("ascii"), COORDINATOR_PORT))
            sock.sendall(request)
            # We don't read the response — fire-and-forget on localhost.
        finally:
            try:
                sock.close()
            except Exception:
                pass

        return True
    except Exception:
        return False


def http_post(path, data):
    """Gated POST — skipped entirely while the coordinator is known to be down,
    so the 30Hz path costs nothing at all. Health checks use _raw_post()."""
    global _post_blocked
    if _post_blocked:
        return  # coordinator is down — zero socket I/O on the render thread

    if _raw_post(path, data):
        if _post_blocked:
            ac.console("[acokit] coordinator reachable again — resuming telemetry")
            _post_blocked = False
    else:
        if not _post_blocked:
            ac.console("[acokit] coordinator unreachable — telemetry paused (retrying every ~10s)")
            _post_blocked = True


# ─── Defensive readers around ac.getCarState ────────────────────────────────
# AC versions/mods expose slightly different fields, so we wrap each read in
# a try/except and return a default. The plugin keeps posting whatever it
# can read, instead of crashing on a missing field.

def safe_state(car_id, key, default=0):
    try:
        return ac.getCarState(car_id, key)
    except Exception:
        return default


def safe_state_indexed(car_id, key, index, default=0):
    try:
        return ac.getCarState(car_id, key, index)
    except Exception:
        return default


def cs(car_id, attr_name, default=0):
    """ac.getCarState guarded by getattr on the acsys.CS member NAME.

    WHY: writing `safe_state(car, acsys.CS.LapTime)` evaluates
    `acsys.CS.LapTime` in the CALLER. If this AC/CSP build doesn't expose that
    enum member, the AttributeError fires before safe_state's try/except can
    catch it — which is exactly what was silently killing the 1Hz plugin-state
    POST (telemetry kept flowing, state never did). Resolving the member by
    name with a default keeps the whole payload builder crash-proof."""
    key = getattr(acsys.CS, attr_name, None)
    if key is None:
        return default
    try:
        v = ac.getCarState(car_id, key)
        return default if v is None else v
    except Exception:
        return default


# ─── acpmf_graphics shared memory readers ───────────────────────────────────
def _ensure_graphics_shm():
    """Lazily open + cache the acpmf_graphics mapping. Returns the mmap handle
    or None. Survives being called before AC finishes init (retries next call)."""
    global graphics_shm, shm_warned
    if not _SHM_AVAILABLE:
        return None
    if graphics_shm is None:
        try:
            graphics_shm = mmap.mmap(-1, GRAPHICS_SHM_SIZE, GRAPHICS_SHM_NAME)
        except Exception:
            if not shm_warned:
                ac.console("[acokit] acpmf_graphics not available yet")
                shm_warned = True
            return None
    return graphics_shm


def _g_int(shm, offset):
    try:
        return struct.unpack("<i", shm[offset:offset + 4])[0]
    except Exception:
        return 0


def read_session_flag():
    """Reads AC_FLAG_TYPE `flag` from acpmf_graphics → 'none'/'yellow'/... Any
    failure degrades quietly to 'none' (never allowed to break telemetry)."""
    shm = _ensure_graphics_shm()
    if shm is None:
        return "none"
    try:
        return FLAG_NAMES.get(_g_int(shm, G_FLAG_OFFSET), "none")
    except Exception:
        return "none"


# ─── Payload builders ───────────────────────────────────────────────────────
def build_telemetry(car_id):
    """Compact ~30Hz snapshot of the focused car's physics. Field names
    are the contract documented in docs/SCHEMA.md."""
    # DRS state of the FOCUSED car. ac.getCarState works for any car (including
    # the spectated one) in a LIVE session — unlike physics shared memory which
    # only holds the local player. In a REPLAY, AC doesn't store the modded-DRS
    # state, so this reads 0 there (the "doesn't work in replay" the director
    # sees). cs() is getattr-guarded so a build lacking acsys.CS.DRS can't crash
    # telemetry. drsAvail is a diagnostic: whether this build exposes the member.
    drs_avail = hasattr(acsys.CS, "DRS")
    drs_value = float(cs(car_id, "DRS", 0.0))

    # Tyre core temp comes back as a 4-element list in modern AC. Some
    # versions need an explicit per-wheel index. Try the list path first.
    tyre_temp = [0.0, 0.0, 0.0, 0.0]
    try:
        raw = ac.getCarState(car_id, acsys.CS.CurrentTyresCoreTemp)
        if isinstance(raw, (list, tuple)) and len(raw) >= 4:
            tyre_temp = [float(raw[i]) for i in range(4)]
    except Exception:
        try:
            tyre_temp = [
                float(safe_state_indexed(car_id, acsys.CS.CurrentTyresCoreTemp, 0)),
                float(safe_state_indexed(car_id, acsys.CS.CurrentTyresCoreTemp, 1)),
                float(safe_state_indexed(car_id, acsys.CS.CurrentTyresCoreTemp, 2)),
                float(safe_state_indexed(car_id, acsys.CS.CurrentTyresCoreTemp, 3)),
            ]
        except Exception:
            pass

    payload = {
        "throttle":   float(safe_state(car_id, acsys.CS.Gas, 0)),
        "brake":      float(safe_state(car_id, acsys.CS.Brake, 0)),
        "clutch":     float(safe_state(car_id, acsys.CS.Clutch, 0)),
        "gear":       int(safe_state(car_id, acsys.CS.Gear, 1)),
        "rpm":        int(safe_state(car_id, acsys.CS.RPM, 0)),
        "speedKmh":   float(safe_state(car_id, acsys.CS.SpeedKMH, 0)),
        # Steer comes back in radians; the overlay normalises to ±1 visually
        # so we just hand it raw and let the overlay handle the conversion.
        "steer":      float(safe_state(car_id, acsys.CS.Steer, 0)),
        "drs":        drs_value,
        "drsAvail":   drs_avail,   # diagnostic: does this AC build expose acsys.CS.DRS?
        "pitLimiter": False,  # not exposed by acsys.CS; needs CSP for live state
        "tyreTemp":   tyre_temp,
        # Lap timing rides the 30Hz channel too so the replay lap tracker can
        # tick a smooth current-lap clock and react to a line crossing on the
        # same frame. Guarded via cs() so a missing acsys.CS member can never
        # break telemetry. NOTE: in replay these acsys calls return 0 for
        # LastLap/BestLap/LapCount — the g* fields below are the real source.
        "lapTimeMs":  int(cs(car_id, "LapTime", 0)),
        "lastLapMs":  int(cs(car_id, "LastLap", 0)),
        "bestLapMs":  int(cs(car_id, "BestLap", 0)),
        "lapCount":   int(cs(car_id, "LapCount", 0)),
        # Normalised lap fraction (0..1). The replay lap tracker uses this to
        # drive the per-sector progress bars, like the live lap_tracker does.
        "splinePosition": float(cs(car_id, "NormalizedSplinePosition", 0.0)),
        # EXACT completed-lap time for the focused car, reconstructed per-frame
        # in acUpdate (acsys LastLap is 0 in replay). lapEvent bumps on each
        # completion so the overlay knows when to reveal completedLapMs.
        "completedLapMs": int(last_completed_lap_ms),
        "lapEvent": int(lap_event_counter),
    }
    return payload


def build_plugin_state(car_id):
    """~1Hz snapshot: spectated driver identity + lap timing of focused car."""
    try:
        driver_name = ac.getDriverName(car_id) or ""
    except Exception:
        driver_name = ""
    try:
        car_name = ac.getCarName(car_id) or ""
    except Exception:
        car_name = ""
    # Tyre compound (e.g. "Soft", "Medium", "Hypersoft"). Lets the replay lap
    # tracker show the compound chip like the live one. Best-effort.
    try:
        tyre_compound = ac.getCarTyreCompound(car_id) or ""
    except Exception:
        tyre_compound = ""

    # Session-wide race-control flag (read from acpmf_graphics, not the
    # focused car). 'yellow' covers a local yellow AND a full-course yellow /
    # Safety Car period — Real Penalty raises the AC yellow flag for those.
    session_flag = read_session_flag()

    return {
        "spectatedDriver": driver_name,
        "spectatedCarId":  int(car_id),
        "carModel":        car_name,
        "isInPit":         bool(cs(car_id, "IsCarInPit", 0)),
        "completedLaps":   int(cs(car_id, "LapCount", 0)),
        "iCurrentTime":    int(cs(car_id, "LapTime", 0)),
        "iLastTime":       int(cs(car_id, "LastLap", 0)),
        "iBestTime":       int(cs(car_id, "BestLap", 0)),
        "currentTire":     tyre_compound,
        "sessionFlag":     session_flag,            # 'none'|'yellow'|'blue'|...
        "yellowFlag":      session_flag == "yellow",
    }


# ─── AC plugin lifecycle ────────────────────────────────────────────────────
def acMain(ac_version):
    """Called once when AC loads the plugin."""
    global app_window
    try:
        # AC requires registering an app window. We make it minimal/invisible.
        app_window = ac.newApp("acokit_telemetry")
        ac.setSize(app_window, 1, 1)
        ac.setTitle(app_window, "")
        try:
            ac.drawBorder(app_window, 0)
        except Exception:
            pass
        try:
            ac.setBackgroundOpacity(app_window, 0)
        except Exception:
            pass
        try:
            # Push the app's tray icon offscreen so it doesn't clutter AC's HUD
            ac.setIconPosition(app_window, 0, -10000)
        except Exception:
            pass

        ac.console("[acokit] Plugin loaded. Posting to %s:%d" % (COORDINATOR_HOST, COORDINATOR_PORT))
    except Exception:
        ac.console("[acokit] acMain error: " + traceback.format_exc())
    _fleet_start()
    return "acokit_telemetry"


def _fleet_start():
    """Open the fleet link if this install is configured for it."""
    global _ws
    if not FLEET_URL or not FLEET_TOKEN:
        return False
    if not _SHM_AVAILABLE:
        ac.console("[acokit] fleet mode needs struct/mmap, which this AC build lacks")
        return False
    _ws = _WsClient(FLEET_URL, _on_ws_message)
    ac.console("[acokit] fleet mode: connecting to " + FLEET_URL)
    return True


def acUpdate(deltaT):
    """Called by AC every frame with the frame time in seconds."""
    global telemetry_accum, state_accum
    global prev_lap_time_ms, prev_focused_for_lap, last_completed_lap_ms, lap_event_counter
    global _post_blocked, _state_retry_count
    try:
        telemetry_accum += deltaT
        state_accum += deltaT

        # Resolve the focused car index. In spectator mode this is the
        # car the director is currently watching. Returns -1 / None if
        # nothing is being focused (menu, loading, etc.).
        try:
            focused_id = ac.getFocusedCar()
        except Exception:
            focused_id = -1
        if focused_id is None or focused_id < 0:
            return

        # ── EXACT lap-completion detection (runs EVERY frame, ~60Hz) ─────────
        # Watch the focused car's LapTime. When it resets at the start/finish
        # line, the completed lap = prevLapTime - curLapTime + frameDelta_ms.
        # This is frame-accurate (no 30Hz/network sampling error) and is the
        # only reliable lap total for the focused car (acsys LastLap == 0 in
        # replay; acpmf_graphics is the local player car, not the focused one).
        cur_lap_ms = int(cs(focused_id, "LapTime", 0))
        if focused_id != prev_focused_for_lap:
            prev_focused_for_lap = focused_id     # don't detect across a car switch
            prev_lap_time_ms = cur_lap_ms
        else:
            if prev_lap_time_ms > 5000 and cur_lap_ms < prev_lap_time_ms - 2000:
                total = prev_lap_time_ms - cur_lap_ms + int(deltaT * 1000)
                if total > 5000:
                    last_completed_lap_ms = total
                    lap_event_counter += 1
            prev_lap_time_ms = cur_lap_ms

        # ── Fleet mode ──────────────────────────────────────────────────
        # One persistent WebSocket instead of a POST per packet, and the
        # SERVER decides the rate: full speed only while this car is the
        # one on camera. Everything below (the HTTP path) is skipped.
        if _ws is not None:
            _ws.pump(time.time())
            if _ws.state == "open":
                global _ws_hello_sent, _fleet_accum
                if not _ws_hello_sent:
                    car = _player_car_id() if FLEET_MODE == "driver" else focused_id
                    _ws_hello_sent = _ws.send_json({
                        "type": "hello",
                        "token": FLEET_TOKEN,
                        "driver": safe_driver_name(car),
                        "carId": int(car),
                        "pluginVersion": PLUGIN_VERSION,
                    })
                else:
                    _fleet_accum += deltaT
                    if _fleet_accum >= (1.0 / max(_ws_hz, 0.5)):
                        _fleet_accum = 0.0
                        car = _player_car_id() if FLEET_MODE == "driver" else focused_id
                        _ws.send_json({"type": "t", "data": build_telemetry(car)})
                    if state_accum >= STATE_INTERVAL_S:
                        state_accum = 0.0
                        car = _player_car_id() if FLEET_MODE == "driver" else focused_id
                        _ws.send_json({"type": "s", "data": build_plugin_state(car)})
            return

        if telemetry_accum >= TELEMETRY_INTERVAL_S:
            telemetry_accum = 0.0
            payload = build_telemetry(focused_id)
            http_post("/api/plugin/telemetry", payload)

        if state_accum >= STATE_INTERVAL_S:
            state_accum = 0.0
            if _post_blocked:
                # While blocked, this 1Hz tick is the ONLY socket I/O the
                # plugin does — and only every STATE_RETRY_TICKS of them.
                if _state_retry_count > 0:
                    _state_retry_count -= 1
                else:
                    payload = build_plugin_state(focused_id)
                    if _raw_post("/api/plugin/state", payload):
                        ac.console("[acokit] coordinator reachable again — resuming telemetry")
                        _post_blocked = False
                    else:
                        _state_retry_count = STATE_RETRY_TICKS
            else:
                payload = build_plugin_state(focused_id)
                http_post("/api/plugin/state", payload)
    except Exception:
        ac.console("[acokit] acUpdate error: " + traceback.format_exc())


def acShutdown():
    """Called once when AC unloads the plugin / closes."""
    global graphics_shm
    if graphics_shm is not None:
        try:
            graphics_shm.close()
        except Exception:
            pass
        graphics_shm = None
    try:
        ac.console("[acokit] Plugin unloaded")
    except Exception:
        pass
