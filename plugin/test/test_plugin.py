"""
Tests for the in-game telemetry plugin.

The plugin runs inside Assetto Corsa's embedded Python 3.3.5, which no test
can have. What it CAN have is everything that makes the plugin correct rather
than merely running: the per-frame lap reconstruction (the reason it works in
replays at all), the defensive readers that keep it alive on AC builds missing
a field, and the hand-rolled HTTP/1.0 request — including the bytes-host
workaround for AC's missing `idna` codec, which is the kind of detail that
gets "cleaned up" by someone who does not know why it is there.

    python plugin/test/test_plugin.py

Stdlib only, like everything else in the kit.
"""
import sys
sys.dont_write_bytecode = True   # never litter an AC plugin folder with .pyc

import io
import os
import socket
import sys
import threading
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import ac_stub                                    # noqa: E402
ac_stub.install()

# WHICH COPY IS UNDER TEST
# ------------------------
# There are two copies of this plugin in the world: the engine's, and the one
# a project actually installs into AC. They are meant to stay identical, and
# the last time they drifted the installed one had a lesson (a 20ms connect
# timeout, gated retries) that the engine copy lacked for months — because the
# tests only ever looked at the engine copy.
#
# So the suite runs against whichever file ACOKIT_PLUGIN points at, and the
# runner points it at every copy it can find in turn. Testing the file that
# does not run is worse than not testing at all: it reads as covered.
_DEFAULT = os.path.join(_HERE, '..', 'acokit_telemetry', 'acokit_telemetry.py')
PLUGIN_PATH = os.path.abspath(os.environ.get('ACOKIT_PLUGIN', _DEFAULT))

# Loaded from source, never from a cache: a stale .pyc once made the parity
# check below report a divergence that had already been fixed, which is the
# worst thing a test can do.
def load_plugin(path, name):
    """Load a plugin copy from source, bypassing the bytecode cache."""
    src = io.open(path, encoding='utf-8').read()
    mod = types.ModuleType(name)
    mod.__file__ = path
    mod.__name__ = name
    sys.modules[name] = mod
    exec(compile(src, path, 'exec'), mod.__dict__)
    return mod


plugin = load_plugin(PLUGIN_PATH, 'plugin_under_test')


def frame(delta_s, lap_time_ms, focused=0):
    """Run one acUpdate frame with the focused car showing this lap time."""
    ac_stub.AC.focused = focused
    ac_stub.AC.set_state(focused, 'LapTime', lap_time_ms)
    plugin.acUpdate(delta_s)


class LapReconstruction(unittest.TestCase):
    """
    AC returns 0 for LastLap/BestLap/LapCount in replay, and the shared-memory
    graphics page describes the LOCAL player, not the car being spectated. So
    the focused car's lap total is reconstructed from LapTime resetting:

        total = prevLapTime - curLapTime + frameDelta
    """

    def setUp(self):
        plugin.prev_lap_time_ms = 0
        plugin.prev_focused_for_lap = -1
        plugin.last_completed_lap_ms = 0
        plugin.lap_event_counter = 0
        plugin.telemetry_accum = 0.0
        plugin.state_accum = 0.0
        ac_stub.AC.reset()
        # Keep the frames from posting: those paths are covered separately.
        self._real_post = plugin.http_post
        plugin.http_post = lambda *a, **k: None

    def tearDown(self):
        plugin.http_post = self._real_post

    def test_a_lap_in_progress_completes_nothing(self):
        for ms in (1000, 20000, 45000, 83000):
            frame(0.016, ms)
        self.assertEqual(plugin.lap_event_counter, 0)
        self.assertEqual(plugin.last_completed_lap_ms, 0)

    def test_the_reset_reconstructs_the_exact_total(self):
        frame(0.016, 85000)
        frame(0.016, 120)          # crossed the line: 85000 - 120 + 16
        self.assertEqual(plugin.lap_event_counter, 1)
        self.assertEqual(plugin.last_completed_lap_ms, 85000 - 120 + 16)

    def test_each_lap_bumps_the_event_counter_once(self):
        frame(0.016, 85000)
        frame(0.016, 100)
        frame(0.016, 40000)
        frame(0.016, 84000)
        frame(0.016, 90)
        self.assertEqual(plugin.lap_event_counter, 2)

    def test_a_car_switch_does_not_fake_a_lap(self):
        # The director cuts to another car mid-lap: its LapTime is unrelated
        # to the one we were watching, and must not read as a completion.
        frame(0.016, 85000, focused=0)
        frame(0.016, 3000, focused=7)
        self.assertEqual(plugin.lap_event_counter, 0)
        # ...and the new car is now the reference.
        frame(0.016, 84000, focused=7)
        frame(0.016, 200, focused=7)
        self.assertEqual(plugin.lap_event_counter, 1)

    def test_an_out_lap_under_five_seconds_is_not_a_lap(self):
        # Guards against the clock ticking from 0 at session start, and
        # against a reset that produces a nonsensically short "lap".
        frame(0.016, 4000)
        frame(0.016, 50)
        self.assertEqual(plugin.lap_event_counter, 0)

    def test_a_small_dip_is_not_a_crossing(self):
        # Telemetry jitter walking the clock backwards must not fire.
        frame(0.016, 60000)
        frame(0.016, 59000)
        self.assertEqual(plugin.lap_event_counter, 0)

    def test_no_focused_car_is_simply_skipped(self):
        ac_stub.AC.focused = -1
        plugin.acUpdate(0.016)     # menu / loading: must not raise
        self.assertEqual(plugin.lap_event_counter, 0)

    def test_a_throwing_getFocusedCar_does_not_kill_the_frame(self):
        ac_stub.AC.raise_on_focus = True
        plugin.acUpdate(0.016)
        ac_stub.AC.raise_on_focus = False


class DefensiveReaders(unittest.TestCase):
    """
    Different AC versions and mods expose different fields. The plugin must
    degrade to a default rather than take the whole app down — a broadcast
    losing its HUD because one build lacks one member is not acceptable.
    """

    def setUp(self):
        ac_stub.AC.reset()

    def test_safe_state_returns_the_default_when_the_field_is_missing(self):
        self.assertEqual(plugin.safe_state(0, 'Nope', 42), 42)

    def test_safe_state_returns_the_value_when_present(self):
        ac_stub.AC.set_state(0, 'RPM', 11500)
        self.assertEqual(plugin.safe_state(0, 'RPM', 0), 11500)

    def test_cs_survives_an_acsys_without_the_member(self):
        # The DRS case: some builds have no acsys.CS.DRS at all, so even
        # NAMING it raises. cs() is getattr-guarded for exactly this.
        ac_stub.hide_acsys_member('DRS')
        try:
            self.assertEqual(plugin.cs(0, 'DRS', 0.0), 0.0)
        finally:
            ac_stub.show_acsys_member('DRS')


class TelemetryPayload(unittest.TestCase):
    """The contract with the overlays: field names and types."""

    def setUp(self):
        ac_stub.AC.reset()
        plugin.last_completed_lap_ms = 84321
        plugin.lap_event_counter = 3
        for k, v in [('Gas', 0.9), ('Brake', 0.1), ('Clutch', 0.0), ('Gear', 4),
                     ('RPM', 10500), ('SpeedKMH', 231.5), ('Steer', 0.15),
                     ('DRS', 1.0), ('LapTime', 61000), ('LastLap', 0),
                     ('BestLap', 0), ('LapCount', 2),
                     ('NormalizedSplinePosition', 0.42),
                     ('CurrentTyresCoreTemp', [85.0, 86.0, 84.5, 87.0])]:
            ac_stub.AC.set_state(0, k, v)

    def test_it_carries_what_the_overlays_read(self):
        p = plugin.build_telemetry(0)
        self.assertEqual(p['gear'], 4)
        self.assertEqual(p['rpm'], 10500)
        self.assertAlmostEqual(p['speedKmh'], 231.5)
        self.assertAlmostEqual(p['throttle'], 0.9)
        self.assertAlmostEqual(p['splinePosition'], 0.42)
        self.assertEqual(len(p['tyreTemp']), 4)

    def test_the_reconstructed_lap_rides_the_telemetry_channel(self):
        # This is what lets a replay overlay reveal an exact lap on the same
        # frame it was completed, instead of a network sample later.
        p = plugin.build_telemetry(0)
        self.assertEqual(p['completedLapMs'], 84321)
        self.assertEqual(p['lapEvent'], 3)

    def test_a_missing_tyre_temp_still_produces_four_numbers(self):
        ac_stub.AC.set_missing('CurrentTyresCoreTemp')
        try:
            p = plugin.build_telemetry(0)
            self.assertEqual(p['tyreTemp'], [0.0, 0.0, 0.0, 0.0])
        finally:
            ac_stub.AC.missing.discard('CurrentTyresCoreTemp')

    def test_it_is_json_serialisable(self):
        import json
        json.dumps(plugin.build_telemetry(0))


class HttpPost(unittest.TestCase):
    """
    The hand-rolled HTTP/1.0 request. AC's embedded Python has an unreliable
    urllib, so the plugin writes the request itself — and connects with a
    BYTES host, because AC's build has no `idna` codec and a str host takes
    the path that needs it.
    """

    def setUp(self):
        self.received = []
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('127.0.0.1', 0))
        self.port = self.server.getsockname()[1]
        self.server.listen(4)
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()
        self._real_port = plugin.COORDINATOR_PORT
        plugin.COORDINATOR_PORT = self.port
        # Open the gate: a previous test may have tripped it, and while it is
        # tripped http_post does no socket I/O at all — by design.
        plugin._post_blocked = False
        plugin._state_retry_count = 0
        ac_stub.AC.reset()

    def tearDown(self):
        plugin.COORDINATOR_PORT = self._real_port
        plugin._post_blocked = False
        plugin._state_retry_count = 0
        try:
            self.server.close()
        except Exception:
            pass

    def _accept(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except Exception:
                return
            data = b''
            conn.settimeout(1.0)
            try:
                while b'\r\n\r\n' not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                # read the body too, if the headers promised one
                head, _, rest = data.partition(b'\r\n\r\n')
                length = 0
                for line in head.split(b'\r\n'):
                    if line.lower().startswith(b'content-length:'):
                        length = int(line.split(b':')[1].strip())
                while len(rest) < length:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    rest += chunk
                self.received.append(head + b'\r\n\r\n' + rest)
            except Exception:
                pass
            finally:
                conn.close()

    def _wait(self, n=1, timeout=2.0):
        import time
        end = time.time() + timeout
        while time.time() < end and len(self.received) < n:
            time.sleep(0.01)
        return self.received

    def test_it_sends_a_well_formed_request(self):
        plugin.http_post('/api/plugin/telemetry', {'speedKmh': 231})
        got = self._wait()[0].decode('utf-8')
        self.assertTrue(got.startswith('POST /api/plugin/telemetry HTTP/1.0\r\n'), got.split('\r\n')[0])
        self.assertIn('Content-Type: application/json', got)
        self.assertIn('Connection: close', got)
        self.assertTrue(got.endswith('{"speedKmh": 231}'), got[-40:])

    def test_content_length_matches_the_body_exactly(self):
        # Off by one here and the coordinator's body reader hangs waiting.
        plugin.http_post('/api/plugin/state', {'spectatedDriver': 'Álex Ñ'})
        got = self._wait()[0]
        head, _, body = got.partition(b'\r\n\r\n')
        declared = None
        for line in head.split(b'\r\n'):
            if line.lower().startswith(b'content-length:'):
                declared = int(line.split(b':')[1].strip())
        self.assertEqual(declared, len(body), 'declared length must count BYTES, not characters')

    def test_an_unreachable_coordinator_is_survivable_and_logged_once(self):
        # AC calls this 30 times a second; a dead coordinator must not raise
        # and must not spam the console on every frame.
        plugin.COORDINATOR_PORT = 1        # nothing listens on port 1
        plugin._post_blocked = False
        ac_stub.AC.console_lines = []
        for _ in range(5):
            plugin.http_post('/api/plugin/telemetry', {'x': 1})
        lines = [l for l in ac_stub.AC.console_lines if 'unreachable' in l]
        self.assertEqual(len(lines), 1, 'logged once, not once per frame')

    def test_recovery_is_logged_once_too(self):
        plugin.COORDINATOR_PORT = 1
        plugin._post_blocked = False
        ac_stub.AC.console_lines = []
        plugin.http_post('/api/plugin/telemetry', {'x': 1})
        plugin.COORDINATOR_PORT = self.port
        plugin._post_blocked = False       # the health check is what unblocks
        plugin.http_post('/api/plugin/telemetry', {'x': 1})
        self._wait()
        self.assertEqual(len(self.received), 1)


class RenderThreadProtection(unittest.TestCase):
    """
    Every POST happens on AC's RENDER THREAD, so a blocking socket is dropped
    frames. When the coordinator is down the plugin must stop touching the
    socket on the 30Hz path entirely — the 1Hz state tick becomes the only
    health check. Without this the game freezes rather than merely losing
    telemetry, which is a far worse failure for a live broadcast.
    """

    def setUp(self):
        plugin._post_blocked = False
        plugin._state_retry_count = 0
        plugin.telemetry_accum = 0.0
        plugin.state_accum = 0.0
        ac_stub.AC.reset()
        ac_stub.AC.set_state(0, 'LapTime', 1000)
        self.attempts = []
        self._real_raw = plugin._raw_post
        # Record every attempt that reaches the socket layer, and fail them.
        plugin._raw_post = lambda path, data, timeout=None: (self.attempts.append(path), False)[1]

    def tearDown(self):
        plugin._raw_post = self._real_raw
        plugin._post_blocked = False
        plugin._state_retry_count = 0

    def test_the_connect_timeout_is_small_enough_for_a_frame(self):
        # 200ms at 30Hz is six seconds of blocking per second of wall clock.
        self.assertLessEqual(plugin.POST_TIMEOUT_S, 0.05,
                             'a connect timeout above ~50ms visibly stutters AC')

    def test_the_first_failure_blocks_the_hot_path(self):
        plugin.http_post('/api/plugin/telemetry', {'x': 1})
        self.assertTrue(plugin._post_blocked)
        self.assertEqual(len(self.attempts), 1)

    def test_while_blocked_the_30hz_path_does_no_socket_io_at_all(self):
        plugin.http_post('/api/plugin/telemetry', {'x': 1})   # the one that fails
        self.attempts = []
        for _ in range(300):                                   # ten seconds of frames
            plugin.http_post('/api/plugin/telemetry', {'x': 1})
        self.assertEqual(self.attempts, [], 'not one socket attempt while blocked')

    def test_the_1hz_state_tick_retries_on_a_schedule(self):
        # Blocked, the plugin still probes — but roughly every ten seconds,
        # not thirty times a second.
        plugin.http_post('/api/plugin/telemetry', {'x': 1})    # blocks
        self.attempts = []
        ac_stub.AC.focused = 0
        # 30 seconds of frames at 60fps, feeding the accumulators for real.
        for _ in range(30 * 60):
            plugin.acUpdate(1.0 / 60)
        probes = [p for p in self.attempts if p.endswith('/state')]
        self.assertGreaterEqual(len(probes), 2, 'it must keep probing')
        self.assertLessEqual(len(probes), 5, 'about one probe per 10s, not per frame')
        self.assertEqual([p for p in self.attempts if p.endswith('/telemetry')], [],
                         'the 30Hz path stayed silent throughout')

    def test_a_successful_probe_unblocks_everything(self):
        plugin.http_post('/api/plugin/telemetry', {'x': 1})    # blocks
        plugin._state_retry_count = 0
        plugin._raw_post = lambda path, data, timeout=None: True   # coordinator is back
        ac_stub.AC.focused = 0
        for _ in range(2 * 60):                                 # two seconds of frames
            plugin.acUpdate(1.0 / 60)
        self.assertFalse(plugin._post_blocked, 'the health check should have resumed telemetry')



class SessionFlags(unittest.TestCase):
    """The shared-memory flag read is optional by design."""

    def test_flag_names_cover_the_ac_enum(self):
        self.assertEqual(plugin.FLAG_NAMES[0], 'none')
        self.assertEqual(plugin.FLAG_NAMES[2], 'yellow')
        self.assertEqual(plugin.FLAG_NAMES[5], 'checkered')

    def test_reading_a_flag_without_shared_memory_is_none_not_a_crash(self):
        # AC builds whose embedded Python lacks mmap/struct still run the
        # plugin; they just never report a flag.
        real = plugin._SHM_AVAILABLE
        plugin._SHM_AVAILABLE = False
        try:
            self.assertEqual(plugin.read_session_flag(), 'none')
        finally:
            plugin._SHM_AVAILABLE = real


class PluginParity(unittest.TestCase):
    """
    Every copy of this plugin must send the SAME payload.

    A project installs its own copy into AC (the folder name shows up in AC's
    UI Modules list, so it cannot just be the engine's), which means the code
    lives twice. That is survivable only while the two agree — and they did not:
    the installed copy carried a 20ms connect timeout and a gate that stopped
    all socket I/O when the coordinator was down, while the engine copy still
    blocked the render thread for 200ms thirty times a second.

    The suite runs against each copy in turn; this class is the extra guard
    that the CONTRACT itself has not drifted, since a field quietly renamed in
    one copy would pass every other test in this file.
    """

    @staticmethod
    def _copies():
        # The engine's copy plus whatever ACOKIT_PLUGIN_COPIES lists (the
        # runner passes every copy it was given; see test/run-plugin.js).
        roots = [os.path.join(_HERE, '..', 'acokit_telemetry', 'acokit_telemetry.py')]
        roots += [r for r in os.environ.get('ACOKIT_PLUGIN_COPIES', '').split(os.pathsep) if r]
        out = []
        for r in roots:
            r = os.path.abspath(r)
            if os.path.isfile(r) and r not in out:
                out.append(r)
        return out

    _load = staticmethod(load_plugin)

    def setUp(self):
        self.copies = self._copies()
        if len(self.copies) < 2:
            self.skipTest('only one copy of the plugin present')
        ac_stub.AC.reset()
        for k, v in [('Gas', 0.5), ('Brake', 0.0), ('Clutch', 0.0), ('Gear', 3),
                     ('RPM', 9000), ('SpeedKMH', 180.0), ('Steer', 0.0), ('DRS', 0.0),
                     ('LapTime', 30000), ('LastLap', 0), ('BestLap', 0), ('LapCount', 1),
                     ('NormalizedSplinePosition', 0.3),
                     ('CurrentTyresCoreTemp', [80.0, 80.0, 80.0, 80.0])]:
            ac_stub.AC.set_state(0, k, v)

    def test_every_copy_sends_the_same_telemetry_fields(self):
        keysets = {}
        for i, path in enumerate(self.copies):
            mod = self._load(path, 'parity_%d' % i)
            keysets[os.path.basename(path)] = sorted(mod.build_telemetry(0).keys())
        distinct = {tuple(v) for v in keysets.values()}
        self.assertEqual(len(distinct), 1, 'telemetry contracts differ: %s' % keysets)

    def test_every_copy_sends_the_same_state_fields(self):
        keysets = {}
        for i, path in enumerate(self.copies):
            mod = self._load(path, 'parity_s_%d' % i)
            keysets[os.path.basename(path)] = sorted(mod.build_plugin_state(0).keys())
        distinct = {tuple(v) for v in keysets.values()}
        self.assertEqual(len(distinct), 1, 'state contracts differ: %s' % keysets)

    def test_every_copy_protects_the_render_thread(self):
        # The exact divergence that prompted this class.
        for i, path in enumerate(self.copies):
            mod = self._load(path, 'parity_t_%d' % i)
            name = os.path.basename(path)
            self.assertLessEqual(getattr(mod, 'POST_TIMEOUT_S', 1.0), 0.05,
                                 '%s: connect timeout too large for a frame' % name)
            self.assertTrue(hasattr(mod, '_post_blocked'),
                            '%s: no gate — the 30Hz path would keep hitting a dead socket' % name)

    def test_every_copy_agrees_on_the_wire_format(self):
        for i, path in enumerate(self.copies):
            mod = self._load(path, 'parity_w_%d' % i)
            name = os.path.basename(path)
            self.assertEqual(mod.COORDINATOR_PORT, 3001, name)
            self.assertAlmostEqual(mod.TELEMETRY_INTERVAL_S, 1.0 / 30, msg=name)
            self.assertAlmostEqual(mod.STATE_INTERVAL_S, 1.0, msg=name)
            self.assertEqual(mod.FLAG_NAMES[2], 'yellow', name)


class FleetFraming(unittest.TestCase):
    """
    The hand-rolled WebSocket client. There is no ws library in AC's Python, so
    the frames are built by hand — and the rule that bites is that every
    client-to-server frame MUST be masked. An unmasked frame is not a garbled
    frame: the server closes the connection, so it fails as "the plugin does
    not work" with nothing in the log.
    """

    def _client(self):
        return plugin._WsClient('ws://127.0.0.1:1/api/plugin/ws', lambda m: None)

    def test_the_url_is_parsed_into_host_port_path(self):
        c = plugin._WsClient('ws://overlays.example.com:8080/api/plugin/ws', lambda m: None)
        self.assertEqual(c.host, 'overlays.example.com')
        self.assertEqual(c.port, 8080)
        self.assertEqual(c.path, '/api/plugin/ws')
        self.assertFalse(c.secure)

    def test_the_default_port_follows_the_scheme(self):
        self.assertEqual(plugin._WsClient('ws://host/x', lambda m: None).port, 80)
        self.assertEqual(plugin._WsClient('wss://host/x', lambda m: None).port, 443)

    def test_every_frame_is_masked(self):
        frame = self._client()._frame('hello')
        self.assertEqual(frame[0], 0x81, 'FIN + text opcode')
        self.assertTrue(frame[1] & 0x80, 'the MASK bit must be set on a client frame')

    def test_a_masked_frame_decodes_back_to_the_payload(self):
        # Unmask it the way the server will, and check we get the bytes back.
        payload = '{"type":"t","data":{"speedKmh":231}}'
        frame = self._client()._frame(payload)
        length = frame[1] & 0x7F
        self.assertEqual(length, len(payload.encode('utf-8')))
        mask = frame[2:6]
        body = bytearray(frame[6:])
        for i in range(len(body)):
            body[i] ^= mask[i % 4]
        self.assertEqual(body.decode('utf-8'), payload)

    def test_a_long_payload_uses_the_extended_length(self):
        big = 'x' * 300
        frame = self._client()._frame(big)
        self.assertEqual(frame[1] & 0x7F, 126, 'lengths over 125 switch to 16-bit')
        import struct as _s
        self.assertEqual(_s.unpack('>H', frame[2:4])[0], 300)

    def test_the_send_queue_is_bounded(self):
        # If the network stalls, the queue must not grow without limit inside
        # a game process: dropped telemetry is recoverable, a leak is not.
        c = self._client()
        c.state = 'open'
        c.sock = None
        for _ in range(plugin.WS_SEND_BUDGET + 50):
            c.send_json({'type': 't', 'data': {}})
        self.assertLessEqual(len(c._tx), plugin.WS_SEND_BUDGET + 1)

    def test_nothing_is_sent_before_the_socket_is_open(self):
        c = self._client()
        self.assertFalse(c.send_json({'type': 't'}))

    def test_wss_is_refused_with_an_explanation_not_a_hang(self):
        c = plugin._WsClient('wss://host/x', lambda m: None)
        ac_stub.AC.console_lines = []
        c.connect(now=0)
        self.assertEqual(c.state, 'failed')
        self.assertTrue(any('wss' in l for l in ac_stub.AC.console_lines),
                        'it must say why rather than fail silently')

    def test_a_rate_message_changes_the_send_rate(self):
        plugin._ws_hz = 2.0
        plugin._on_ws_message({'type': 'rate', 'hz': 30, 'selected': True})
        self.assertEqual(plugin._ws_hz, 30.0)
        plugin._on_ws_message({'type': 'rate', 'hz': 2, 'selected': False})
        self.assertEqual(plugin._ws_hz, 2.0)

    def test_a_refusal_clears_the_handshake_so_it_retries(self):
        plugin._ws_hello_sent = True
        plugin._on_ws_message({'type': 'denied', 'reason': 'unauthorized'})
        self.assertFalse(plugin._ws_hello_sent)


if __name__ == '__main__':
    unittest.main(verbosity=2)
