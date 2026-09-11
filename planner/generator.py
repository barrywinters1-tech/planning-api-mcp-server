"""Rule-based programme generator. No AI: production rates, sequencing rules, arithmetic.

Two entry points:
    parse_brief(text) -> Brief          keyword and number extraction from a plain-English brief
    generate(brief)   -> DraftPlan       WBS, activities, durations, logic, milestones

Durations come from production rates (m² per gang-day and similar) that are
deliberately conservative UK tender-programme figures. Every rate is listed in
RATES so a planner can tune them, and every derived assumption is written into
the plan's assumptions list.
"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .plan import DraftPlan, PlanActivity, PlanConstraint, PlanLink, PlanWBS

BuildingType = Literal["house", "houses", "apartments", "office", "warehouse", "school", "refurbishment", "generic"]
Frame = Literal["masonry", "rc", "steel", "timber"]
Foundations = Literal["strip", "raft", "piled"]
Envelope = Literal["brick", "render", "cladding", "curtain_wall"]
Roof = Literal["pitched", "flat"]
FitOut = Literal["shell", "basic", "full"]


class Brief(BaseModel):
    name: str = "New project"
    building_type: BuildingType = "generic"
    storeys: int = 2
    gross_internal_area_m2: float = 0.0  # 0 = derive from type
    units: int = 0                       # dwellings, for houses/apartments
    frame: Optional[Frame] = None
    foundations: Optional[Foundations] = None
    envelope: Optional[Envelope] = None
    roof: Optional[Roof] = None
    fit_out: FitOut = "full"
    basement: bool = False
    demolition: bool = False
    service_diversion: bool = False
    contaminated_ground: bool = False
    external_works: bool = True
    start_date: Optional[date] = None
    deadline: Optional[date] = None
    six_day_week: bool = False
    planning_condition_date: Optional[date] = None
    location: str = ""
    source_text: str = ""


# ------------------------------------------------------------------------------------
# production rates (working days unless stated). Tune here.
# ------------------------------------------------------------------------------------
RATES = {
    "site_setup_base": 5, "site_setup_per_1000m2": 1,
    "demolition_m2_per_day": 120,
    "service_diversion_days": 15,
    "remediation_m2_per_day": 100,
    "reduce_level_m2_per_day": 250,
    "basement_m2_per_day": 25,
    "strip_found_m2_per_day": 60,
    "raft_m2_per_day": 90,
    "piles_per_day": 8, "m2_per_pile": 12,
    "pile_caps_m2_per_day": 120,
    "drainage_m2_per_day": 150,
    "ground_slab_m2_per_day": 120,
    "frame_masonry_m2_per_day": 35,
    "frame_rc_m2_per_day": 45, "rc_cure_days": 3,
    "frame_steel_m2_per_day": 180, "steel_deck_m2_per_day": 150,
    "frame_timber_m2_per_day": 120,
    "roof_m2_per_day": 70,
    "envelope_brick_m2_per_day": 45, "envelope_render_m2_per_day": 70,
    "envelope_cladding_m2_per_day": 110, "envelope_curtain_wall_m2_per_day": 90,
    "windows_base": 3, "windows_per_storey": 2,
    "first_fix_m2_per_day": 90, "drylining_m2_per_day": 70, "screed_m2_per_day": 250,
    "second_fix_m2_per_day": 80, "decoration_m2_per_day": 110, "finishes_m2_per_day": 160,
    "commissioning_base": 10, "commissioning_per_storey": 2,
    "externals_base": 10, "externals_m2_per_day": 120,
    "snagging_days": 10,
    "max_activity_days": 40,   # split anything longer into zones
    "zone_m2": 900,            # floor plates above this are zoned
}

DEFAULT_GIA = {"house": 150, "houses": 95, "apartments": 75, "office": 1200, "warehouse": 3000,
               "school": 2500, "refurbishment": 800, "generic": 800}


# ------------------------------------------------------------------------------------
# brief parsing
# ------------------------------------------------------------------------------------
MONTHS = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july",
                                          "august", "september", "october", "november", "december"])}
MONTHS.update({k[:3]: v for k, v in MONTHS.items()})
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
         "ten": 10, "single": 1, "twelve": 12, "twenty": 20}


def _num(tok: str) -> Optional[float]:
    tok = tok.lower().replace(",", "")
    if tok in WORDS:
        return float(WORDS[tok])
    try:
        return float(tok)
    except ValueError:
        return None


def _find_dates(text: str) -> list[tuple[int, date, str]]:
    """Return (position, date, preceding words) for every date-like phrase."""
    out = []
    t = text.lower()
    for m in re.finditer(r"(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\w*\s+(\d{4})", t):
        d = date(int(m[3]), MONTHS[m[2]], int(m[1]))
        out.append((m.start(), d, t[max(0, m.start() - 40):m.start()]))
    for m in re.finditer(r"\b(" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\w*\s+(\d{4})\b", t):
        if any(abs(o[0] - m.start()) < 12 for o in out):
            continue
        out.append((m.start(), date(int(m[2]), MONTHS[m[1]], 1), t[max(0, m.start() - 40):m.start()]))
    for m in re.finditer(r"\b(\d{4})-(\d{2})-(\d{2})\b", t):
        out.append((m.start(), date(int(m[1]), int(m[2]), int(m[3])), t[max(0, m.start() - 40):m.start()]))
    for m in re.finditer(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", t):
        out.append((m.start(), date(int(m[3]), int(m[2]), int(m[1])), t[max(0, m.start() - 40):m.start()]))
    for m in re.finditer(r"christmas\s+(\d{4})", t):
        out.append((m.start(), date(int(m[1]), 12, 18), t[max(0, m.start() - 40):m.start()]))
    for m in re.finditer(r"\b(?:q([1-4])|(?:end|start)\s+of\s+(\d{4}))\b", t):
        if m[1]:
            yr = re.search(r"(\d{4})", t[m.end():m.end() + 8])
            if yr:
                out.append((m.start(), date(int(yr[1]), 3 * int(m[1]), 28), t[max(0, m.start() - 40):m.start()]))
        elif m[2]:
            out.append((m.start(), date(int(m[2]), 12 if "end" in m[0] else 1, 15 if "end" in m[0] else 6),
                        t[max(0, m.start() - 40):m.start()]))
    return sorted(out)


def parse_brief(text: str) -> Brief:
    t = text.lower()
    b = Brief(source_text=text.strip())

    # building type
    for key, pats in [("apartments", r"apartment|flat|unit block|residential block"), ("houses", r"houses|dwellings|plots|housing"),
                      ("house", r"\bhouse\b|dwelling|bungalow"), ("warehouse", r"warehouse|industrial|distribution|shed"),
                      ("office", r"office|commercial"), ("school", r"school|academy|college|classroom"),
                      ("refurbishment", r"refurb|retrofit|conversion|remodel|extension")]:
        if re.search(pats, t):
            b.building_type = key  # type: ignore[assignment]
            break
    if b.building_type == "houses" and re.search(r"\b(one|1|a|single)\s+(new\s+)?(house|dwelling)", t):
        b.building_type = "house"

    m = re.search(r"(\d+|" + "|".join(WORDS) + r")[\s-]*(?:storey|story|stories|storeys|floors?|levels?)\b", t)
    if m and _num(m[1]):
        b.storeys = int(_num(m[1]))
    if re.search(r"\bbungalow\b|single[\s-]storey", t):
        b.storeys = 1
    m = re.search(r"(\d[\d,]*(?:\.\d+)?)\s*(?:m2|m²|sqm|sq\.?\s*m|square met)", t)
    if m:
        b.gross_internal_area_m2 = float(m[1].replace(",", ""))
    m = re.search(r"(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft|ft2|square feet)", t)
    if m and not b.gross_internal_area_m2:
        b.gross_internal_area_m2 = round(float(m[1].replace(",", "")) / 10.764)
    m = re.search(r"(\d+)[\s-]*(?:unit|flat|apartment|dwelling|house|plot|bed)", t)
    if m:
        b.units = int(m[1])

    if re.search(r"\brc\b|reinforced concrete|concrete frame|in[\s-]situ", t):
        b.frame = "rc"
    elif re.search(r"steel[\s-]frame|steel portal|portal frame|structural steel", t):
        b.frame = "steel"
    elif re.search(r"timber[\s-]frame|clt|cross[\s-]laminated|sips", t):
        b.frame = "timber"
    elif re.search(r"masonry|brick and block|blockwork|traditional", t):
        b.frame = "masonry"
    if re.search(r"pil(e|ing)", t):
        b.foundations = "piled"
    elif re.search(r"\braft\b", t):
        b.foundations = "raft"
    elif re.search(r"strip found|trench fill", t):
        b.foundations = "strip"
    if re.search(r"curtain wall|glazed facade|unitised", t):
        b.envelope = "curtain_wall"
    elif re.search(r"cladding|rainscreen|composite panel|metal panel", t):
        b.envelope = "cladding"
    elif re.search(r"brick", t):
        b.envelope = "brick"
    elif re.search(r"\brender", t):
        b.envelope = "render"
    if re.search(r"flat roof|single ply|green roof|membrane roof", t):
        b.roof = "flat"
    elif re.search(r"pitched|tiled roof|slate|trusses", t):
        b.roof = "pitched"
    if re.search(r"shell (and|&) core|shell-and-core", t):
        b.fit_out = "shell"
    elif re.search(r"cat ?a\b|basic fit", t):
        b.fit_out = "basic"
    b.basement = bool(re.search(r"basement|undercroft", t))
    b.demolition = bool(re.search(r"demoli|strip[\s-]out|knock down|clearance of (the )?existing", t))
    b.service_diversion = bool(re.search(r"diver(t|sion)|\bkv\b|live cable|gas main|water main|utility", t))
    b.contaminated_ground = bool(re.search(r"contaminat|remediat|brownfield|asbestos|made ground", t))
    b.external_works = not re.search(r"no external works|excluding externals", t)
    b.six_day_week = bool(re.search(r"six[\s-]day|6[\s-]day|saturday", t))
    m = re.search(r"\b(?:in|at|near)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)", text)
    if m:
        b.location = m[1]

    prev_end = 0
    for pos, d, before in _find_dates(text):
        before = t[max(prev_end, pos - 40):pos]
        prev_end = pos + 6
        if re.search(r"start|commenc|possession|mobilis|on site|begin", before):
            b.start_date = b.start_date or d
        elif re.search(r"handover|complet|finish|deadline|by|before|open|occupy|deliver|christmas|end", before + " " + str(d)):
            b.deadline = b.deadline or d
        elif re.search(r"planning|condition|discharg", before):
            b.planning_condition_date = d
        elif b.start_date is None:
            b.start_date = d
        elif b.deadline is None:
            b.deadline = d

    m = re.match(r"\s*([^.\n]{8,80})", text)
    if m:
        b.name = m[1].strip().rstrip(",")[:60]
        b.name = b.name[0].upper() + b.name[1:]
    return b


# ------------------------------------------------------------------------------------
# generation
# ------------------------------------------------------------------------------------
def _defaults(b: Brief) -> Brief:
    b = b.model_copy()
    if not b.gross_internal_area_m2:
        per = DEFAULT_GIA[b.building_type]
        b.gross_internal_area_m2 = per * b.units if b.units and b.building_type in ("houses", "apartments") else per * (b.storeys if b.building_type in ("office", "generic") else 1)
    if b.storeys < 1:
        b.storeys = 1
    if b.frame is None:
        b.frame = ("masonry" if b.building_type in ("house", "houses") else "steel" if b.building_type in ("warehouse", "office")
                   else "rc" if b.storeys >= 4 or b.building_type == "apartments" else "masonry")
    if b.foundations is None:
        b.foundations = "piled" if b.storeys >= 4 or b.contaminated_ground or b.basement else "raft" if b.building_type == "warehouse" else "strip"
    if b.envelope is None:
        b.envelope = ("cladding" if b.building_type == "warehouse" else "curtain_wall" if b.building_type == "office" and b.storeys >= 5
                      else "brick")
    if b.roof is None:
        b.roof = "pitched" if b.building_type in ("house", "houses") or (b.frame == "masonry" and b.storeys <= 3) else "flat"
    if b.start_date is None:
        today = date.today()
        b.start_date = today + timedelta(days=(7 - today.weekday()) % 7 or 7)
    return b


def _days(x: float, lo: float = 1) -> float:
    return max(lo, round(x * 2) / 2)


class _Builder:
    def __init__(self, b: Brief):
        self.b = b
        self.acts: list[PlanActivity] = []
        self.wbs: list[PlanWBS] = []
        self.n = 990
        self.assumptions: list[str] = []
        self.cal = "six_day" if b.six_day_week else "standard"

    def nid(self) -> str:
        self.n += 10
        return f"A{self.n}"

    def add(self, name: str, wbs: str, days: float, preds: list[tuple[str, str, float]] | list[str] = (), trade: str = "",
            atype: str = "task", calendar: Optional[str] = None, crew: float = 0) -> str:
        aid = self.nid()
        links = []
        for p in preds:
            if isinstance(p, str):
                links.append(PlanLink(predecessor_id=p))
            else:
                links.append(PlanLink(predecessor_id=p[0], type=p[1], lag_days=p[2]))  # type: ignore[arg-type]
        self.acts.append(PlanActivity(id=aid, name=name, wbs_code=wbs, type=atype, duration_days=0 if atype != "task" else _days(days),
                                      calendar=calendar or self.cal, predecessors=links, trade=trade, crew_size=crew))  # type: ignore[arg-type]
        return aid

    def chain(self, name: str, wbs: str, total_days: float, preds, trade: str, zones: int, stagger: float = 2) -> tuple[list[str], str]:
        """Split work into zones linked SS+stagger, return (zone ids, id of last)."""
        if zones <= 1:
            a = self.add(name, wbs, total_days, preds, trade)
            return [a], a
        per = total_days / zones
        ids = []
        for z in range(zones):
            p = list(preds) if z == 0 else [ids[-1]]  # same gang moves zone to zone
            ids.append(self.add(f"{name} - zone {z + 1}", wbs, per, p, trade))
        return ids, ids[-1]


def generate(brief: Brief) -> DraftPlan:
    b = _defaults(brief)
    R = RATES
    x = _Builder(b)
    gia = b.gross_internal_area_m2
    storeys = b.storeys
    footprint = gia / storeys
    zones = max(1, min(4, math.ceil(footprint / R["zone_m2"])))
    x.assumptions += [
        f"Gross internal area {gia:,.0f} m² over {storeys} storey(s); footprint {footprint:,.0f} m²"
        + (f" split into {zones} zones for trade flow" if zones > 1 else ""),
        f"Frame: {b.frame}; foundations: {b.foundations}; envelope: {b.envelope}; roof: {b.roof}; fit-out: {b.fit_out}",
        "Working week " + ("Monday to Saturday" if b.six_day_week else "Monday to Friday") + ", 8 hours, UK bank holidays non-working",
        "Durations from RATES production table in planner/generator.py; single gang per trade unless zoned",
    ]

    wbs = ["Enabling works", "Substructure", "Frame and upper floors", "Roof and envelope", "Internal fit-out",
           "External works", "Commissioning and handover"]
    for i, w in enumerate(wbs, 1):
        x.wbs.append(PlanWBS(code=str(i), name=w))
    W = {w: str(i) for i, w in enumerate(wbs, 1)}

    # ---- 1 enabling
    start = x.add("Start on site", W["Enabling works"], 0, [], atype="start_milestone")
    setup = x.add("Site set-up, welfare, hoarding and temporary works", W["Enabling works"],
                  R["site_setup_base"] + R["site_setup_per_1000m2"] * footprint / 1000, [start], "Groundworks gang", crew=3)
    enabling_done = [setup]
    if b.service_diversion:
        enabling_done.append(x.add("Service diversions and temporary supplies", W["Enabling works"], R["service_diversion_days"],
                                   [start], "Utilities contractor"))
        x.assumptions.append("Statutory undertaker diversions assumed 15 working days once on site; confirm with DNO/water")
    if b.demolition:
        enabling_done = [x.add("Soft strip and demolition", W["Enabling works"], footprint / R["demolition_m2_per_day"] + 3,
                               enabling_done, "Demolition contractor", crew=4)]
    if b.contaminated_ground:
        enabling_done = [x.add("Ground remediation and validation", W["Enabling works"], footprint / R["remediation_m2_per_day"] + 5,
                               enabling_done, "Remediation contractor")]
    dig = x.add("Strip topsoil and reduce levels", W["Enabling works"], footprint / R["reduce_level_m2_per_day"] + 1, enabling_done,
                "Groundworks gang", crew=3)

    # ---- 2 substructure
    S = W["Substructure"]
    if b.basement:
        dig = x.add("Basement excavation, propping and retaining walls", S, footprint / R["basement_m2_per_day"], [dig], "Groundworks gang", crew=6)
    if b.foundations == "piled":
        piles = math.ceil(footprint / R["m2_per_pile"])
        pil = x.add(f"Piling ({piles} piles)", S, piles / R["piles_per_day"] + 2, [dig], "Piling contractor", crew=4)
        found = x.add("Pile caps and ground beams", S, footprint / R["pile_caps_m2_per_day"] + 4, [(pil, "SS", 5), pil], "Groundworks gang", crew=4)
        x.assumptions.append(f"{piles} CFA piles at one per {R['m2_per_pile']} m² of footprint, {R['piles_per_day']} per rig-day")
    elif b.foundations == "raft":
        found = x.add("Raft foundation (formwork, rebar, pour)", S, footprint / R["raft_m2_per_day"] + 4, [dig], "Groundworks gang", crew=5)
    else:
        exc = x.add("Excavate and pour strip foundations", S, footprint / R["strip_found_m2_per_day"] + 2, [dig], "Groundworks gang", crew=4)
        insp = x.add("Building control inspection - foundations", S, 1, [(exc, "SS", max(1, footprint / R["strip_found_m2_per_day"]))], "Site manager")
        found = x.add("Blockwork to DPC", S, footprint / 90 + 3, [exc, insp], "Bricklayers", crew=4)
    cure = x.add("Concrete cure", S, R["rc_cure_days"], [found], calendar="seven_day")
    drain = x.add("Below-ground drainage", S, footprint / R["drainage_m2_per_day"] + 2, [dig], "Groundworks gang", crew=3)
    slab = x.add("Ground floor slab, DPM and insulation", S, footprint / R["ground_slab_m2_per_day"] + 2, [cure, drain], "Groundworks gang", crew=4)
    sub_done = x.add("Substructure complete", S, 0, [slab], atype="finish_milestone")

    # ---- 3 frame per storey
    F = W["Frame and upper floors"]
    frame_ids: list[str] = []   # last activity of each storey's frame
    prev = sub_done
    for lvl in range(storeys):
        label = "ground floor" if lvl == 0 else f"level {lvl}"
        if b.frame == "rc":
            cols = x.add(f"RC columns and walls - {label}", F, footprint / R["frame_rc_m2_per_day"] + 2, [prev], "RC frame contractor", crew=8)
            deck = x.add(f"Suspended slab formwork, rebar and pour - {label}", F, footprint / R["frame_rc_m2_per_day"] + 3, [cols], "RC frame contractor", crew=8)
            c = x.add(f"Slab cure - {label}", F, R["rc_cure_days"], [deck], calendar="seven_day")
            prev = c
        elif b.frame == "steel":
            if lvl == 0:
                prev = x.add("Steel frame erection (all levels)", F, gia / R["frame_steel_m2_per_day"] + 4, [prev], "Steel erectors", crew=6)
                x.assumptions.append("Steel frame erected in one continuous visit; decking and concrete floors follow floor by floor")
            if lvl > 0:
                prev = x.add(f"Metal decking and concrete topping - {label}", F, footprint / R["steel_deck_m2_per_day"] + 2,
                             [prev] if lvl == 1 else [(prev, "FS", 0)], "Decking contractor", crew=4)
            elif storeys == 1:
                pass
        elif b.frame == "timber":
            prev = x.add(f"Timber frame panels and floor cassettes - {label}", F, footprint / R["frame_timber_m2_per_day"] + 1, [prev], "Timber frame erectors", crew=5)
        else:
            lift = x.add(f"Brick and block to {'first floor' if lvl == 0 else 'level ' + str(lvl + 1) if lvl + 1 < storeys else 'wall plate'}", F,
                         footprint / R["frame_masonry_m2_per_day"], [prev], "Bricklayers", crew=6)
            if lvl + 1 < storeys:
                prev = x.add(f"Floor joists or precast planks - level {lvl + 1}", F, footprint / 300 + 2, [lift], "Carpenters", crew=3)
            else:
                prev = lift
        frame_ids.append(prev)
    frame_done = x.add("Frame complete", F, 0, [prev], atype="finish_milestone")

    # ---- 4 roof and envelope
    E = W["Roof and envelope"]
    roof = x.add("Roof structure" + (" and trusses" if b.roof == "pitched" else " and screed to falls"), E, footprint / R["roof_m2_per_day"] + 3,
                 [frame_done], "Roofers" if b.roof == "pitched" else "Roofing contractor", crew=4)
    roof_cover = x.add("Roof covering" + (" (felt, batten, tile)" if b.roof == "pitched" else " (membrane and insulation)"), E,
                       footprint / R["roof_m2_per_day"] + 2, [roof], "Roofers", crew=4)
    env_rate = R[f"envelope_{b.envelope}_m2_per_day"]
    perimeter = 4 * math.sqrt(footprint)          # square-plan approximation
    wall_area_per_storey = perimeter * 3.2
    env_ids = []
    env_prev = None
    for lvl in range(storeys):
        label = "ground floor" if lvl == 0 else f"level {lvl}"
        preds: list = [frame_ids[min(lvl + 1, storeys - 1)]] if b.frame != "masonry" else [frame_done]
        if env_prev:
            preds.append(env_prev)  # same envelope gang works up the building
        env_prev = x.add(f"External envelope ({b.envelope.replace('_', ' ')}) - {label}", E, wall_area_per_storey / env_rate + 1, preds,
                         "Bricklayers" if b.envelope in ("brick", "render") else "Cladding contractor", crew=6)
        env_ids.append(env_prev)
    if b.frame == "masonry":
        x.assumptions.append("Masonry frame: external leaf built with the structure, envelope activities cover pointing, cavity closers and render/brick feature work")
    windows = x.add("Windows, curtain walling and external doors", E, R["windows_base"] + R["windows_per_storey"] * storeys, [env_ids[-1]],
                    "Window fitters", crew=3)
    rwg = x.add("Fascias, soffits and rainwater goods", E, footprint / 200 + 2, [roof_cover], "Roofers")
    watertight = x.add("Watertight", E, 0, [roof_cover, windows, env_ids[-1]], atype="finish_milestone")
    strike = x.add("Strike scaffold", E, 2 + storeys, [rwg, windows, env_ids[-1]], "Scaffolders")

    # ---- 5 internal fit-out, floor by floor
    I = W["Internal fit-out"]
    last_second_fix: list[str] = []
    prev_floor: dict[str, str] = {}
    if b.fit_out != "shell":
        for lvl in range(storeys):
            label = "ground floor" if lvl == 0 else f"level {lvl}"
            area = footprint

            def stage(key: str, name: str, rate_key: str, preds, trade, crew=3, extra=0.0):
                p = list(preds)
                if key in prev_floor:
                    p.append(prev_floor[key])  # one gang per trade: finish the floor below first
                ids, last = x.chain(f"{name} - {label}", I, area / R[rate_key] + extra, p, trade, zones)
                prev_floor[key] = last
                return last

            ff_pred = [watertight] if lvl == storeys - 1 else [frame_ids[min(lvl + 1, storeys - 1)], env_ids[lvl]]
            carp = stage("carp1", "First fix carpentry and partitions", "first_fix_m2_per_day", ff_pred, "Carpenters")
            mep1 = stage("mep1", "First fix mechanical and electrical", "first_fix_m2_per_day", [carp], "M&E contractor", crew=4)
            dry = stage("dry", "Drylining, plastering and ceilings", "drylining_m2_per_day", [carp, mep1], "Dryliners", crew=4)
            if b.fit_out == "full":
                scr = stage("screed", "Screed", "screed_m2_per_day", [dry], "Screeders")
                dry_out = x.add(f"Drying out - {label}", I, 5, [scr, dry], calendar="seven_day")
                base = [dry_out]
            else:
                base = [dry]
            carp2 = stage("carp2", "Second fix carpentry, doors and joinery", "second_fix_m2_per_day", base, "Carpenters")
            mep2 = stage("mep2", "Second fix mechanical and electrical", "second_fix_m2_per_day", [carp2], "M&E contractor", crew=4)
            if b.fit_out == "full":
                if b.building_type in ("house", "houses", "apartments"):
                    kit = stage("kit", "Kitchens, bathrooms and tiling", "second_fix_m2_per_day", [carp2, mep2], "Kitchen and bathroom fitters")
                    dec_pred = [kit, mep2]
                else:
                    dec_pred = [carp2, mep2]
                dec = stage("dec", "Decoration", "decoration_m2_per_day", dec_pred, "Decorators")
                fin = stage("fin", "Floor finishes", "finishes_m2_per_day", [dec], "Floor layers")
                last_second_fix += [fin, mep2]
            else:
                last_second_fix += [carp2, mep2]
    else:
        x.assumptions.append("Shell and core only: no internal fit-out beyond first fix of landlord services")
        core = x.add("Landlord services and core fit-out", I, gia / R["first_fix_m2_per_day"] + 5, [watertight], "M&E contractor", crew=4)
        last_second_fix = [core]

    # ---- 6 externals
    X = W["External works"]
    ext_ids = []
    if b.external_works:
        e1 = x.add("External drainage, services connections and paving", X, R["externals_base"] + footprint / R["externals_m2_per_day"], [strike],
                   "Groundworks gang", crew=4)
        e2 = x.add("Roads, car parking, fencing and landscaping", X, R["externals_base"] + footprint / R["externals_m2_per_day"], [e1],
                   "Groundworks gang", crew=4)
        ext_ids = [e2]
    else:
        x.assumptions.append("External works excluded from this programme")
        ext_ids = [strike]

    # ---- 7 commissioning and handover
    C = W["Commissioning and handover"]
    power = x.add("Power on", C, 0, [last_second_fix[-1] if last_second_fix else watertight], atype="finish_milestone")
    comm = x.add("Testing, commissioning and O&M manuals", C, R["commissioning_base"] + R["commissioning_per_storey"] * storeys,
                 [power] + last_second_fix, "M&E contractor", crew=3)
    bc = x.add("Building control completion and certificates", C, 2, [comm] + ext_ids + ([strike] if strike not in ext_ids else []), "Site manager")
    snag = x.add("Snagging, builder's clean and client inspections", C, R["snagging_days"], [bc], "Site manager", crew=4)
    x.add("Practical completion", C, 0, [snag], atype="finish_milestone")

    constraints = []
    if b.planning_condition_date:
        constraints.append(PlanConstraint(activity_id=dig, type="start_on_or_after", date=b.planning_condition_date.isoformat(),
                                          reason="Pre-commencement planning conditions"))
    questions = ["Confirm gross internal area and storey heights from the drawings",
                 "Confirm procurement lead-ins for frame, windows and M&E plant (not modelled as activities)",
                 "Is a phased handover acceptable?"]
    if b.deadline:
        questions.append("Is the completion date contractual (LADs) or a target?")
    pid = re.sub(r"[^A-Za-z0-9]+", "-", (b.location or b.building_type)).strip("-").upper()[:8] or "PROJ"
    return DraftPlan(project_id=f"{pid}-{b.start_date:%y%m}", project_name=b.name, start_date=b.start_date.isoformat(),
                     must_finish_by=b.deadline.isoformat() if b.deadline else None, wbs=x.wbs, activities=x.acts,
                     constraints=constraints, assumptions=x.assumptions, questions_for_client=questions,
                     summary=f"Generated programme: {len(x.acts)} activities, {storeys}-storey {b.building_type} of {gia:,.0f} m², "
                             f"{b.frame} frame on {b.foundations} foundations.")
