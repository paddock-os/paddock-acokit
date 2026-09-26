"""
Fake `ac` / `acsys` modules, so the in-game plugin can be imported and driven
outside Assetto Corsa.

The plugin's whole reason for existing is that it reads the FOCUSED car — the
one a director is spectating — through AC's Python API. That API is the one
thing a test cannot have, so this is the seam: install these stubs into
sys.modules before importing the plugin, then set the car state a test wants.

    import ac_stub
    ac_stub.install()
    ac_stub.AC.focused = 3
    ac_stub.AC.set_state(3, 'LapTime', 61000)
"""
import sys
import types


class FakeAC:
    """Records what the plugin did, and answers what it asks."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.focused = 0
        self.state = {}        # (car_id, attr_name) -> value
        self.console_lines = []
        self.raise_on_focus = False
        self.missing = set()   # attr names that should raise, like an old AC build

    # ── what a test sets up ────────────────────────────────────────────────
    def set_state(self, car_id, attr_name, value):
        self.state[(car_id, attr_name)] = value

    def set_missing(self, attr_name):
        """Make this field raise, the way a build without it would."""
        self.missing.add(attr_name)

    # ── what the plugin calls ──────────────────────────────────────────────
    def getFocusedCar(self):
        if self.raise_on_focus:
            raise RuntimeError('no focus')
        return self.focused

    def getCarState(self, car_id, key, *args):
        # `key` is whatever acsys.CS.<Name> resolved to — our stub makes that
        # the attribute NAME, so the lookup reads naturally in a test.
        if key in self.missing:
            raise RuntimeError('field not available in this build: %s' % key)
        if (car_id, key) not in self.state:
            raise RuntimeError('unset: %s for car %s' % (key, car_id))
        return self.state[(car_id, key)]

    def getDriverName(self, car_id):
        return self.state.get((car_id, '__name'), 'Driver %d' % car_id)

    def getCarName(self, car_id):
        return self.state.get((car_id, '__car'), 'car_model')

    def console(self, msg):
        self.console_lines.append(msg)

    def log(self, msg):
        self.console_lines.append(msg)

    # UI surface the plugin touches in acMain — no-ops here.
    def newApp(self, name): return 1
    def setSize(self, *a): return 0
    def setTitle(self, *a): return 0
    def setBackgroundOpacity(self, *a): return 0
    def drawBorder(self, *a): return 0
    def addLabel(self, *a): return 1
    def setPosition(self, *a): return 0
    def setFontSize(self, *a): return 0
    def setText(self, *a): return 0


class _CS:
    """acsys.CS — every member resolves to its own name.

    That is the trick that makes the stub readable: the plugin passes
    `acsys.CS.LapTime` to getCarState, and the stub receives the string
    'LapTime', which is what a test set up.
    """
    def __getattr__(self, name):
        if name in _CS_MISSING:
            raise AttributeError(name)
        return name


_CS_MISSING = set()

AC = FakeAC()


def hide_acsys_member(name):
    """Simulate an AC build whose acsys.CS lacks a member (e.g. DRS)."""
    _CS_MISSING.add(name)


def show_acsys_member(name):
    _CS_MISSING.discard(name)


def install():
    """Put the stubs in sys.modules. Call before importing the plugin."""
    ac_mod = types.ModuleType('ac')
    for name in dir(AC):
        if not name.startswith('_'):
            setattr(ac_mod, name, getattr(AC, name))
    sys.modules['ac'] = ac_mod

    acsys_mod = types.ModuleType('acsys')
    acsys_mod.CS = _CS()
    sys.modules['acsys'] = acsys_mod
    return ac_mod, acsys_mod
