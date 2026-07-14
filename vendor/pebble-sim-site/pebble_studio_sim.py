# pebble_studio_sim.py — Pebble Studio simulated location & weather for pypkjs.
#
# WHY: weather watchfaces fetch real weather over the network via
# navigator.geolocation + XMLHttpRequest, both of which funnel through `requests`
# inside the bundled pypkjs. With no phone (and dead hardcoded API keys) the fetch
# fails and the watch shows a sentinel (e.g. an "unknown condition" placeholder).
#
# This module, installed from sitecustomize when PEBBLE_SIM_ENV_FILE is set, wraps
# requests.Session.send so calls to known weather hosts return synthetic JSON built
# from a control file, calls to api.ipify.org return a canned IP (offline geo), and
# patches pygeoip so getCurrentPosition resolves to the configured lat/lon. Every
# branch is guarded so a failure falls back to real behavior and never breaks the
# emulator.
import json
import os
import time
from urllib.parse import urlparse

# category -> (OpenWeatherMap weather[].id, WeatherAPI condition.code)
# Codes chosen so a watchface's own condition-code mapping resolves them to the
# intended internal icon category.
CONDITIONS = {
    "clear":   (800, 1000),
    "partly":  (801, 1003),
    "cloudy":  (804, 1006),
    "fog":     (741, 1135),
    "drizzle": (301, 1153),
    "rain":    (501, 1189),
    "sleet":   (612, 1207),
    "snow":    (601, 1213),
    "thunder": (211, 1087),
    "wind":    (905, 1117),
}

DEFAULTS = {
    "enabled": True,
    "location": {"lat": 33.6846, "lon": -117.8265, "name": "Irvine"},
    "weather": {"condition": "clear", "tempC": 20.56, "isDay": True},
    "units": "F",
}

_state = {"mtime": None, "cfg": None}


def _read(env_file):
    """Absent/unreadable/malformed -> DEFAULTS (enabled). Cached by mtime so a
    long-lived process re-reads only when the UI rewrites the file."""
    try:
        st = os.stat(env_file)
    except OSError:
        return DEFAULTS
    if st.st_mtime == _state["mtime"] and _state["cfg"] is not None:
        return _state["cfg"]
    try:
        with open(env_file, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return DEFAULTS
    _state["mtime"] = st.st_mtime
    _state["cfg"] = cfg
    return cfg


def _to_f(c):
    return round(c * 9.0 / 5.0 + 32)


def build_owm(cfg):
    w = cfg.get("weather", DEFAULTS["weather"])
    loc = cfg.get("location", DEFAULTS["location"])
    owm_id = CONDITIONS.get(w.get("condition"), CONDITIONS["clear"])[0]
    now = int(time.time())
    if w.get("isDay", True):
        sunrise, sunset = now - 21600, now + 21600   # dt within (sunrise,sunset) => day
    else:
        sunrise, sunset = now - 43200, now - 3600     # dt > sunset => night
    temp_c = w.get("tempC", 20.56)
    kelvin = temp_c + 273.15
    return {
        "coord": {"lat": loc.get("lat", 0), "lon": loc.get("lon", 0)},
        "weather": [{"id": owm_id, "main": "", "description": ""}],
        "main": {"temp": kelvin, "temp_min": kelvin - 3, "temp_max": kelvin + 3},
        "sys": {"sunrise": sunrise, "sunset": sunset},
        "dt": now,
        "name": loc.get("name", ""),
    }


def build_weatherapi(cfg):
    w = cfg.get("weather", DEFAULTS["weather"])
    code = CONDITIONS.get(w.get("condition"), CONDITIONS["clear"])[1]
    temp_c = w.get("tempC", 20.56)
    is_day = 1 if w.get("isDay", True) else 0
    return {
        "current": {
            "temp_c": round(temp_c),
            "temp_f": _to_f(temp_c),
            "is_day": is_day,
            "condition": {"code": code, "text": ""},
        },
        "forecast": {"forecastday": [{
            "day": {
                "maxtemp_c": round(temp_c) + 3, "mintemp_c": round(temp_c) - 3,
                "maxtemp_f": _to_f(temp_c) + 5, "mintemp_f": _to_f(temp_c) - 5,
            },
            "astro": {"sunrise": "06:00 AM", "sunset": "08:00 PM"},
        }]},
    }


def _json_response(req, payload):
    from requests.models import Response
    r = Response()
    r.status_code = 200
    r.reason = "OK"
    r._content = json.dumps(payload).encode("utf-8")
    r._content_consumed = True
    r.encoding = "utf-8"
    r.url = getattr(req, "url", "")
    r.request = req
    r.headers["Content-Type"] = "application/json"
    return r


def _text_response(req, text):
    from requests.models import Response
    r = Response()
    r.status_code = 200
    r.reason = "OK"
    r._content = text.encode("utf-8")
    r._content_consumed = True
    r.encoding = "utf-8"
    r.url = getattr(req, "url", "")
    r.request = req
    r.headers["Content-Type"] = "text/plain"
    return r


def install(env_file):
    import requests.sessions

    if getattr(requests.sessions.Session.send, "_pebble_sim", False):
        return

    _orig_send = requests.sessions.Session.send

    def send(self, request, **kwargs):
        try:
            cfg = _read(env_file)
            if cfg.get("enabled", True):
                host = (urlparse(getattr(request, "url", "")).hostname or "").lower()
                if host == "api.openweathermap.org":
                    return _json_response(request, build_owm(cfg))
                if host == "api.weatherapi.com":
                    return _json_response(request, build_weatherapi(cfg))
                if host == "api.ipify.org":
                    return _text_response(request, "8.8.8.8")
        except Exception:
            pass
        return _orig_send(self, request, **kwargs)

    send._pebble_sim = True
    requests.sessions.Session.send = send

    try:
        import pygeoip
        _orig_rec = pygeoip.GeoIP.record_by_addr

        def record_by_addr(self, addr, *a, **k):
            try:
                cfg = _read(env_file)
                if cfg.get("enabled", True):
                    loc = cfg.get("location", DEFAULTS["location"])
                    return {
                        "latitude": loc.get("lat", 0.0),
                        "longitude": loc.get("lon", 0.0),
                        "city": loc.get("name", ""),
                        "country_code": "", "country_name": "",
                        "region_code": "", "region_name": "",
                        "time_zone": "", "metro_code": "",
                        "area_code": 0, "postal_code": "", "dma_code": 0,
                    }
            except Exception:
                pass
            return _orig_rec(self, addr, *a, **k)

        pygeoip.GeoIP.record_by_addr = record_by_addr
    except Exception:
        pass


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        owm = build_owm(DEFAULTS)
        wapi = build_weatherapi(DEFAULTS)
        assert owm["weather"][0]["id"] == 800, owm
        assert round(owm["main"]["temp"] - 273.15) == 21, owm
        assert owm["sys"]["sunrise"] < owm["dt"] < owm["sys"]["sunset"], owm
        assert wapi["current"]["condition"]["code"] == 1000, wapi
        assert wapi["current"]["temp_f"] == 69, wapi
        assert wapi["current"]["is_day"] == 1, wapi
        # night flips day/night markers
        night = dict(DEFAULTS, weather=dict(DEFAULTS["weather"], isDay=False))
        owm_n = build_owm(night)
        assert not (owm_n["sys"]["sunrise"] < owm_n["dt"] < owm_n["sys"]["sunset"]), owm_n
        assert build_weatherapi(night)["current"]["is_day"] == 0
        print("OK")
