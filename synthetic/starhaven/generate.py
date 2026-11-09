"""Generate all analytics projections from one private, deterministic world."""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from .catalog import ROOT, SCALE, schema


def digest(*parts):
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()


def draw(seed, *parts):
    return int(digest(seed, *parts)[:16], 16)


def implementation_fingerprint():
    return digest(
        *(
            hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in ("generate.py", "catalog.py", "model-spec.json")
        )
    )


def stamp(day):
    return day + " 00:00:00.000"


def money(value):
    if value is None:
        return None
    sign = "-" if value < 0 else ""
    value = abs(int(value))
    return f"{sign}{value // SCALE}.{value % SCALE:06d}"


def ratio(numerator, denominator):
    if not denominator:
        return None
    return (Decimal(numerator) / Decimal(denominator) * 100).quantize(
        Decimal(".000001"), rounding=ROUND_HALF_UP
    )


class World:
    def __init__(self, settings, start, days, installs, seed, scenario, row_budget):
        self.settings, self.start, self.days, self.installs, self.seed = (
            settings,
            start,
            days,
            installs,
            seed,
        )
        self.scenario = scenario
        self.dates = [(start + timedelta(days=i)).isoformat() for i in range(days)]
        self.end = self.dates[-1]
        self.specs = {m["asset"]: m for m in schema()}
        self.rows = {name: {} for name in self.specs}
        self.active = defaultdict(set)
        self.cohorts = defaultdict(int)
        self.exp_enrolled = defaultdict(int)
        self.oracle = defaultdict(int)
        self.window_oracle = defaultdict(set)
        self.forecast_cost = defaultdict(int)
        self.forecast_revenue = defaultdict(lambda: defaultdict(int))
        self.private_device_count = 0
        self.total_rows = 0
        self.row_budget = row_budget
        self.config_hash = digest(
            json.dumps(settings, sort_keys=True, ensure_ascii=False)
        )
        self.implementation_hash = implementation_fingerprint()
        self.version = (
            "sv_"
            + digest(
                self.config_hash,
                self.implementation_hash,
                start,
                days,
                installs,
                seed,
                scenario,
            )[:20]
        )

    def put(self, table, keys, increments=None, attrs=None):
        spec = self.specs[table]
        values = {"dataset_version": self.version, **keys}
        identity = tuple(
            values[name] for name in ["dataset_version"] + spec["dimensions"]
        )
        if identity not in self.rows[table]:
            self.total_rows += 1
            if self.total_rows > self.row_budget:
                raise ValueError("published_row_budget_exceeded")
            row = {}
            for c in spec["columns"]:
                row[c["name"]] = (
                    0
                    if c["name"] in spec["measures"]
                    else (
                        None
                        if c["nullable"]
                        else (
                            "0.000000"
                            if "Decimal" in c["type"]
                            else 0 if "UInt" in c["type"] else ""
                        )
                    )
                )
            row.update(values)
            self.rows[table][identity] = row
        row = self.rows[table][identity]
        for key, value in (increments or {}).items():
            if value is not None:
                previous = row.get(key)
                if isinstance(previous, str) and previous == "0.000000":
                    previous = 0
                row[key] = (previous or 0) + value
        for key, value in (attrs or {}).items():
            if key == "completeness_state" and row.get(key) == "partial":
                continue
            row[key] = value
        return row

    def dim(self):
        for i, game in enumerate(self.settings["games"]):
            for platform in ("ios", "android"):
                app = game["id"] + "_" + platform
                self.put(
                    "dim_app",
                    {"app_id": app},
                    attrs=dict(
                        game_id=game["id"],
                        game_name=game["name"],
                        game_kind=game["kind"],
                        platform=platform,
                        bundle_id="org.starhaven." + app,
                        launch_date=self.dates[0],
                        business_timezone="UTC",
                        supported_mode_codes=game["modes"],
                    ),
                )
                for c in range(4):
                    upload = (
                        (self.start - timedelta(days=3)).isoformat()
                        if c < 2
                        else self.dates[3]
                    )
                    self.put(
                        "dim_creative",
                        {"creative_id": f"{app}_cr{c}"},
                        attrs=dict(
                            app_id=app,
                            creative_name=f'{game["name"]}合成素材{c}',
                            format_code="video" if c % 2 == 0 else "image",
                            upload_at=stamp(upload),
                            duration_seconds=15 if c % 2 == 0 else 0,
                            aspect_ratio="9:16",
                            tag_codes="bright,short" if c % 2 == 0 else "quiet,puzzle",
                        ),
                    )
                for channel in ("breeze", "moss"):
                    campaign = f"{app}_{channel}_camp"
                    self.put(
                        "dim_campaign",
                        {"campaign_id": campaign},
                        attrs=dict(
                            media_code="sim_" + channel,
                            account_id="acct_" + channel,
                            app_id=app,
                            campaign_name=game["name"] + "_" + platform + "_" + channel,
                            objective_code="first_open",
                            budget_level="campaign",
                            created_at=stamp(self.dates[0]),
                        ),
                    )
                    group = campaign + "_group"
                    self.put(
                        "dim_ad_group",
                        {"ad_group_id": group},
                        attrs=dict(
                            media_code="sim_" + channel,
                            account_id="acct_" + channel,
                            campaign_id=campaign,
                            ad_group_name=group,
                            optimization_event_code="first_open",
                            created_at=stamp(self.dates[0]),
                        ),
                    )
                    for a in (0, 1):
                        self.put(
                            "dim_ad",
                            {"ad_id": campaign + f"_ad{a}"},
                            attrs=dict(
                                media_code="sim_" + channel,
                                account_id="acct_" + channel,
                                campaign_id=campaign,
                                ad_group_id=group,
                                ad_name=campaign + f"_ad{a}",
                                primary_creative_id=f"{app}_cr{a}",
                                created_at=stamp(self.dates[0]),
                            ),
                        )
                    for offset, field, old, new in [
                        (0, "status", None, "active"),
                        (0, "budget_local", None, "100.000000"),
                        (
                            self.settings["simulation"]["budget_cut_offset"],
                            "budget_local",
                            "100.000000",
                            "60.000000",
                        ),
                    ]:
                        if offset >= self.days:
                            continue
                        self.put(
                            "fact_ad_operation_event",
                            {
                                "operation_event_id": digest(app, channel, offset)[:24],
                                "field_name": field,
                            },
                            attrs=dict(
                                app_id=app,
                                media_code="sim_" + channel,
                                account_id="acct_" + channel,
                                entity_type="campaign",
                                entity_id=campaign,
                                effective_at=stamp(self.dates[offset]),
                                recorded_at=stamp(self.dates[offset]),
                                old_value=old,
                                new_value=new,
                                value_type="state" if field == "status" else "decimal",
                                unit=(
                                    "state"
                                    if field == "status"
                                    else ("USD" if channel == "breeze" else "XCU")
                                ),
                                change_source="synthetic_controlled_operation",
                            ),
                        )
                    if app == "gridfit_ios" and channel == "moss":
                        pause = self.settings["simulation"]["pause_start_offset"]
                        for offset, old, new in [
                            (pause, "active", "paused"),
                            (
                                pause + self.settings["simulation"]["pause_days"],
                                "paused",
                                "active",
                            ),
                        ]:
                            if offset < self.days:
                                self.put(
                                    "fact_ad_operation_event",
                                    dict(
                                        operation_event_id=digest(app, channel, offset)[
                                            :24
                                        ],
                                        field_name="status",
                                    ),
                                    attrs=dict(
                                        app_id=app,
                                        media_code="sim_" + channel,
                                        account_id="acct_" + channel,
                                        entity_type="campaign",
                                        entity_id=campaign,
                                        effective_at=stamp(self.dates[offset]),
                                        recorded_at=stamp(self.dates[offset]),
                                        old_value=old,
                                        new_value=new,
                                        value_type="state",
                                        unit="state",
                                        change_source="synthetic_controlled_operation",
                                    ),
                                )
                for experiment_type in ("product", "monetization"):
                    for arm in ("control", "variant"):
                        self.put(
                            "dim_experiment_arm",
                            dict(
                                experiment_id=app + "_" + experiment_type,
                                arm_id=arm,
                                config_version="1",
                            ),
                            attrs=dict(
                                app_id=app,
                                experiment_type=experiment_type,
                                allocation_unit="synthetic_device_app",
                                allocation_fraction=Decimal(".5"),
                                eligibility_code=(
                                    "first_open_v1"
                                    if experiment_type == "product"
                                    else "first_ad_show_v1"
                                ),
                                anchor_type=(
                                    "first_open"
                                    if experiment_type == "product"
                                    else "first_ad_show"
                                ),
                                control_arm_id="control",
                                starts_at=stamp(self.dates[0]),
                                ends_at=stamp(
                                    (self.start + timedelta(days=730)).isoformat()
                                ),
                            ),
                        )
                self.put(
                    "config_business_policy_snapshot",
                    dict(
                        policy_id="demo_recovery",
                        policy_version="1",
                        effective_from=stamp(self.dates[0]),
                        scope_type="app",
                        scope_key=app,
                    ),
                    attrs=dict(effective_to=None, **self.settings["policy"]),
                )
        for code, name, region, tier in self.settings["countries"]:
            self.put(
                "dim_country",
                {"country_code": code},
                attrs=dict(country_name=name, region=region, tier_code=tier),
            )
        for channel, name, media, category, paid in self.settings["channels"]:
            self.put(
                "dim_ua_channel",
                {"ua_channel_id": channel},
                attrs=dict(
                    channel_name=name,
                    media_code=media,
                    channel_category=category,
                    is_paid=paid,
                    classification_version="1",
                ),
            )
        for channel, currency in [("breeze", "USD"), ("moss", "XCU")]:
            self.put(
                "dim_ad_account",
                {"account_id": "acct_" + channel},
                attrs=dict(
                    media_code="sim_" + channel,
                    account_name="合成账户_" + channel,
                    account_currency=currency,
                    account_timezone="UTC",
                ),
            )
        for d, day in enumerate(self.dates):
            for currency, rate in [("USD", 1), ("XCU", 2 + d % 2)]:
                self.put(
                    "fact_fx_rate_daily",
                    dict(rate_date=day, source_currency=currency),
                    attrs=dict(
                        source_currency_per_usd=Decimal(rate), rate_status="known"
                    ),
                )

    def delivery(self, app, cohort, country, channel, ad_no, paid):
        campaign = f"{app}_{channel}_camp" if paid else None
        ad = campaign + f"_ad{ad_no}" if paid else None
        creative = f"{app}_cr{ad_no}" if paid else None
        base = dict(
            app_id=app,
            acquisition_country_code=country,
            ua_channel_id=channel,
            campaign_id=campaign,
            ad_group_id=campaign + "_group" if paid else None,
            ad_id=ad,
            creative_id=creative,
        )
        return base

    def simulate(self):
        for app_row in self.rows["dim_app"].values():
            app = app_row["app_id"]
            for c, cohort in enumerate(self.dates):
                # The budget cut is a synthetic hidden driver, never an online answer asset.
                n = self.installs
                for u in range(n):
                    device = f"{app}:{cohort}:{u}"
                    h = draw(self.seed, device, "identity")
                    country = self.settings["countries"][
                        h % len(self.settings["countries"])
                    ][0]
                    channel = ("breeze", "moss", "organic")[h // 7 % 3]
                    paid = channel != "organic"
                    pause = self.settings["simulation"]["pause_start_offset"]
                    if (
                        app == "gridfit_ios"
                        and channel == "moss"
                        and pause
                        <= c
                        < pause + self.settings["simulation"]["pause_days"]
                    ):
                        continue
                    if (
                        paid
                        and c >= self.settings["simulation"]["budget_cut_offset"]
                        and h % 4 == 0
                    ):
                        continue
                    self.private_device_count += 1
                    ad_no = h // 11 % 2
                    base = self.delivery(app, cohort, country, channel, ad_no, paid)
                    cohort_key = tuple(
                        base[k]
                        for k in (
                            "app_id",
                            "acquisition_country_code",
                            "ua_channel_id",
                            "campaign_id",
                            "ad_group_id",
                            "ad_id",
                            "creative_id",
                        )
                    ) + (cohort,)
                    self.cohorts[cohort_key] += 1
                    raw_cost = (
                        (self.settings["simulation"]["paid_cost_microusd"] + h % 500000)
                        if paid
                        else 0
                    )
                    cost = raw_cost * 9 // 10
                    factor = 1 if channel == "breeze" else 2 + c % 2
                    self.put(
                        "fact_delivery_daily",
                        dict(
                            business_date=cohort,
                            account_id="acct_" + channel if paid else None,
                            **base,
                        ),
                        dict(
                            raw_cost_local=raw_cost * factor,
                            discounted_cost_local=cost * factor,
                            raw_cost_usd=raw_cost,
                            discounted_cost_usd=cost,
                            impressions=(100 + h % 100) if paid else 0,
                            clicks=(5 + h % 10) if paid else 0,
                            media_registers=1 + (h % 13 == 0) if paid else 0,
                            af_registers=1 if paid else 0,
                        ),
                        dict(
                            source_currency=(
                                ("USD" if channel == "breeze" else "XCU")
                                if paid
                                else "USD"
                            ),
                            fx_rate_date=cohort,
                            cost_scope="discounted_media_delivery",
                            completeness_state="complete",
                        ),
                    )
                    self.oracle["discounted_cost_usd"] += cost
                    fkey = (cohort, app, country, channel, base["campaign_id"])
                    self.forecast_cost[fkey] += cost
                    late = h % 17 == 0
                    visible = c + (1 if late else 0) < self.days
                    self.put(
                        "fact_acquisition_daily",
                        dict(cohort_date=cohort, **base),
                        dict(
                            unique_install_events=int(visible),
                            first_install_devices=int(visible),
                            reinstall_events=0,
                            late_install_events=int(late and visible),
                            unattributed_install_events=int(not paid and visible),
                        ),
                        dict(
                            arrival_cutoff=stamp(
                                (
                                    date.fromisoformat(self.end) + timedelta(days=1)
                                ).isoformat()
                            ),
                            completeness_state="complete" if visible else "partial",
                        ),
                    )
                    self.oracle["install_events_visible"] += int(visible)
                    product_arm = (
                        "variant"
                        if draw(self.seed, app, "product", device) % 2
                        else "control"
                    )
                    monetization_arm = (
                        "variant"
                        if draw(self.seed, app, "monetization", device) % 2
                        else "control"
                    )
                    anchors = {"product": c}
                    for age in range(self.days - c):
                        day_no, day = c + age, self.dates[c + age]
                        quality = self.settings["simulation"][
                            "retention_base_per_mille"
                        ]
                        if product_arm == "variant":
                            quality += 40
                        if c >= self.settings["simulation"]["retention_shift_offset"]:
                            quality -= 90
                        reinstall = age == 7 and h % 11 == 0
                        active = (
                            age == 0
                            or reinstall
                            or draw(self.seed, device, age, "active") % 1000
                            < max(8, quality * 3 // (age + 3))
                        )
                        if not active:
                            continue
                        if reinstall:
                            visible_reinstall = day_no + int(late) < self.days
                            self.put(
                                "fact_acquisition_daily",
                                dict(cohort_date=day, **base),
                                dict(
                                    unique_install_events=int(visible_reinstall),
                                    first_install_devices=0,
                                    reinstall_events=int(visible_reinstall),
                                    late_install_events=int(late and visible_reinstall),
                                    unattributed_install_events=int(
                                        not paid and visible_reinstall
                                    ),
                                ),
                                dict(
                                    arrival_cutoff=stamp(
                                        (
                                            date.fromisoformat(self.end)
                                            + timedelta(days=1)
                                        ).isoformat()
                                    ),
                                    completeness_state=(
                                        "complete" if visible_reinstall else "partial"
                                    ),
                                ),
                            )
                            self.oracle["install_events_visible"] += int(
                                visible_reinstall
                            )
                        self.active[(app, country, channel, day_no)].add(device)
                        if day_no >= self.days - 7:
                            self.window_oracle[(app, 7)].add(device)
                        if day_no >= self.days - 30:
                            self.window_oracle[(app, 30)].add(device)
                        r = draw(self.seed, device, age, "outcome")
                        games = 1 + r % 5
                        seconds = games * (40 + r % 180)
                        usage = seconds + 20
                        show_count = 0 if age == 0 and h % 3 == 0 else 1 + r % 5
                        if show_count and monetization_arm == "variant" and age > 0:
                            show_count += 1
                        revenue = 0
                        for ad_format in ("interstitial", "rewarded", "banner"):
                            network = ("sim_orbit", "sim_cedar")[
                                draw(self.seed, device, age, ad_format) % 2
                            ]
                            impressions = show_count + (
                                1 if ad_format == "banner" and show_count else 0
                            )
                            micros_each = (
                                1000
                                + draw(self.seed, device, age, ad_format, "revenue")
                                % 15000
                            )
                            if (
                                network == "sim_orbit"
                                and day_no
                                >= self.settings["simulation"]["network_shift_offset"]
                            ):
                                micros_each = micros_each * 7 // 10
                            amount = impressions * micros_each
                            revenue += amount
                            self.put(
                                "fact_ad_funnel_daily",
                                dict(
                                    business_date=day,
                                    app_id=app,
                                    activity_country_code=country,
                                    ad_format=ad_format,
                                    network_code=network,
                                    event_schema_version="synthetic_ad_v1",
                                ),
                                dict(
                                    load_attempts=impressions + 2,
                                    completed_load_attempts=impressions + 2,
                                    successful_load_attempts=impressions + 1,
                                    show_actions=impressions + 1,
                                    ready_actions=impressions,
                                    completed_show_requests=impressions + 1,
                                    successful_show_requests=impressions,
                                    impressions=impressions,
                                    clicks=r % 2,
                                    revenue_usd=amount,
                                ),
                                dict(completeness_state="complete"),
                            )
                        total_impressions = 3 * show_count + int(show_count > 0)
                        self.oracle["sdk_revenue_usd"] += revenue
                        if age <= 30:
                            self.oracle["cohort30_revenue_usd"] += revenue
                        self.oracle["active_device_days"] += 1
                        self.oracle["game_count"] += games
                        self.put(
                            "fact_activity_daily",
                            dict(
                                activity_date=day,
                                app_id=app,
                                acquisition_country_code=country,
                                ua_channel_id=channel,
                            ),
                            dict(
                                active_devices=1,
                                new_active_devices=int(age == 0),
                                returning_active_devices=int(age > 0),
                                sessions=1 + r % 3,
                                gameplay_seconds=seconds,
                                game_count=games,
                                ad_viewing_devices=int(total_impressions > 0),
                                ad_impressions=total_impressions,
                                ad_revenue_usd=revenue,
                            ),
                            dict(
                                device_identity_rule="synthetic_device_app_first_install_v1",
                                completeness_state="complete",
                            ),
                        )
                        if age <= 30:
                            self.put(
                                "fact_cohort_quality_daily",
                                dict(
                                    install_cohort_date=cohort, observe_date=day, **base
                                ),
                                dict(
                                    retained_devices=1,
                                    game_count=games,
                                    gameplay_seconds=seconds,
                                    usage_seconds=usage,
                                    ad_impressions=total_impressions,
                                    ad_revenue_usd=revenue,
                                ),
                                dict(
                                    age_days=age,
                                    maturity_state="observed",
                                    completeness_state="complete",
                                ),
                            )
                        mode = (
                            "unconfirmed"
                            if app_row["game_kind"] == "unconfirmed"
                            else (
                                "level"
                                if app_row["game_kind"] == "fall" or r % 2
                                else "endless"
                            )
                        )
                        wins_eligible = games if mode == "level" else 0
                        self.put(
                            "fact_gameplay_daily",
                            dict(
                                business_date=day,
                                app_id=app,
                                activity_country_code=country,
                                mode_code=mode,
                                level_bucket=(
                                    "1-10" if mode == "level" else "not_applicable"
                                ),
                            ),
                            dict(
                                games_started=games + int(r % 5 == 0),
                                games_finished=games,
                                eligible_win_games=wins_eligible,
                                games_won=games // 2 if wins_eligible else None,
                                gameplay_seconds=seconds,
                                total_score=(
                                    games * (10 + r % 100)
                                    if mode != "unconfirmed"
                                    else 0
                                ),
                                revive_prompts=games,
                                revive_clicks=games // 2,
                                successful_revives=games // 2,
                            ),
                            dict(
                                score_unit=(
                                    app_row["game_id"] + "_" + mode + "_points"
                                    if mode != "unconfirmed"
                                    else "not_applicable"
                                ),
                                gameplay_schema_version="1",
                                completeness_state="complete",
                            ),
                        )
                        if not wins_eligible:
                            gameplay = self.rows["fact_gameplay_daily"]
                            ident = (
                                self.version,
                                day,
                                app,
                                country,
                                mode,
                                "not_applicable",
                            )
                            gameplay[ident]["games_won"] = None
                            if mode == "unconfirmed":
                                gameplay[ident]["total_score"] = None
                        for source in ("sdk", "af"):
                            # AF has a one-day reporting delay and partial callback matching.
                            if source == "af" and day_no + 1 >= self.days:
                                continue
                            observed_revenue = (
                                revenue if source == "sdk" else revenue * 9 // 10
                            )
                            self.put(
                                "fact_cohort_revenue_daily",
                                dict(
                                    cohort_date=cohort,
                                    revenue_date=day,
                                    revenue_source=source,
                                    **base,
                                ),
                                dict(
                                    revenue_usd=observed_revenue,
                                    revenue_callback_count=(
                                        total_impressions
                                        if source == "sdk"
                                        else total_impressions * 9 // 10
                                    ),
                                ),
                                dict(
                                    age_days=age,
                                    observed_at=stamp(
                                        day
                                        if source == "sdk"
                                        else self.dates[day_no + 1]
                                    ),
                                    completeness_state="complete",
                                ),
                            )
                        self.forecast_revenue[fkey][age] += revenue
                        if "monetization" not in anchors and total_impressions > 0:
                            anchors["monetization"] = day_no
                        for experiment_type, anchor in anchors.items():
                            if day_no - anchor > 30:
                                continue
                            arm = (
                                product_arm
                                if experiment_type == "product"
                                else monetization_arm
                            )
                            ekey = (
                                app + "_" + experiment_type,
                                arm,
                                "1",
                                app,
                                self.dates[anchor],
                                country,
                            )
                            if day_no == anchor:
                                self.exp_enrolled[ekey] += 1
                            self.put(
                                "fact_experiment_cohort_daily",
                                dict(
                                    experiment_id=ekey[0],
                                    arm_id=arm,
                                    config_version="1",
                                    app_id=app,
                                    entry_cohort_date=ekey[4],
                                    observe_date=day,
                                    entry_country_code=country,
                                ),
                                dict(
                                    active_units=1,
                                    gameplay_seconds=seconds,
                                    ad_impressions=total_impressions,
                                    ad_revenue_usd=revenue,
                                ),
                                dict(
                                    anchor_type=(
                                        "first_open"
                                        if experiment_type == "product"
                                        else "first_ad_show"
                                    ),
                                    age_days=day_no - anchor,
                                    assignment_version="hash-v1",
                                    completeness_state="complete",
                                ),
                            )

    def complete_series(self):
        # Explicit zeros within an eligible cohort are different from missing rows.
        for key, size in self.cohorts.items():
            app, country, channel, campaign, group, ad, creative, cohort = key
            c = (date.fromisoformat(cohort) - self.start).days
            base = dict(
                app_id=app,
                acquisition_country_code=country,
                ua_channel_id=channel,
                campaign_id=campaign,
                ad_group_id=group,
                ad_id=ad,
                creative_id=creative,
            )
            for age in range(min(31, self.days - c)):
                self.put(
                    "fact_cohort_quality_daily",
                    dict(
                        install_cohort_date=cohort,
                        observe_date=self.dates[c + age],
                        **base,
                    ),
                    attrs=dict(
                        cohort_size_devices=size,
                        age_days=age,
                        maturity_state="observed",
                        completeness_state="complete",
                    ),
                )
        starts = {}
        for app, country, channel, day_no in self.active:
            segment = (app, country, channel)
            starts[segment] = min(starts.get(segment, day_no), day_no)
        for (app, country, channel), first_day in sorted(starts.items()):
            # A future first observation must not add rows to earlier releases.
            for d in range(first_day, self.days):
                day = self.dates[d]
                keys = dict(
                    activity_date=day,
                    app_id=app,
                    acquisition_country_code=country,
                    ua_channel_id=channel,
                )
                n7 = len(
                    set().union(
                        *(
                            self.active.get((app, country, channel, i), set())
                            for i in range(max(0, d - 6), d + 1)
                        )
                    )
                )
                n30 = len(
                    set().union(
                        *(
                            self.active.get((app, country, channel, i), set())
                            for i in range(max(0, d - 29), d + 1)
                        )
                    )
                )
                self.put(
                    "fact_activity_daily",
                    keys,
                    attrs=dict(
                        active_devices_7d=n7,
                        active_devices_30d=n30,
                        device_identity_rule="synthetic_device_app_first_install_v1",
                        completeness_state="complete",
                    ),
                )
        for key, enrolled in self.exp_enrolled.items():
            experiment, arm, version, app, entry, country = key
            anchor = (date.fromisoformat(entry) - self.start).days
            for d in range(anchor, min(self.days, anchor + 31)):
                self.put(
                    "fact_experiment_cohort_daily",
                    dict(
                        experiment_id=experiment,
                        arm_id=arm,
                        config_version=version,
                        app_id=app,
                        entry_cohort_date=entry,
                        observe_date=self.dates[d],
                        entry_country_code=country,
                    ),
                    attrs=dict(
                        enrolled_units=enrolled,
                        observed_units=enrolled,
                        anchor_type=(
                            "first_open"
                            if experiment.endswith("_product")
                            else "first_ad_show"
                        ),
                        age_days=d - anchor,
                        assignment_version="hash-v1",
                        completeness_state="complete",
                    ),
                )

    def forecasts(self):
        for key, cost in sorted(
            self.forecast_cost.items(), key=lambda pair: str(pair[0])
        ):
            cohort, app, country, channel, campaign = key
            if not cost:
                continue
            cohort_offset = (date.fromisoformat(cohort) - self.start).days
            ages = self.forecast_revenue[key]
            for observed in (3, 7, 14, 30):
                snap = cohort_offset + observed
                if snap >= self.days:
                    continue
                visible = sum(value for age, value in ages.items() if age < observed)
                for horizon in (7, 30, 90, 360):
                    if horizon <= observed:
                        continue
                    for version in ("baseline_linear_v1", "baseline_tail_v2"):
                        factor = (
                            Decimal(horizon) / observed
                            if version == "baseline_linear_v1"
                            else Decimal(1)
                            + Decimal(horizon - observed) / (observed + 30)
                        )
                        predicted = int(
                            (Decimal(visible) * factor).quantize(
                                Decimal(1), rounding=ROUND_HALF_UP
                            )
                        )
                        pid = digest(
                            self.seed, *key, self.dates[snap], horizon, version
                        )[:32]
                        self.put(
                            "fact_roi_forecast_snapshot",
                            dict(
                                snapshot_date=self.dates[snap],
                                cohort_date=cohort,
                                app_id=app,
                                acquisition_country_code=country,
                                ua_channel_id=channel,
                                campaign_id=campaign,
                                horizon_days=horizon,
                                model_version=version,
                                revenue_source="sdk",
                            ),
                            attrs=dict(
                                prediction_id=pid,
                                input_cutoff=stamp(self.dates[snap]),
                                observed_age_days=observed,
                                cost_as_of_usd=cost,
                                predicted_revenue_usd=predicted,
                                predicted_roi_pct=ratio(predicted, cost),
                                prediction_state="predicted",
                            ),
                        )
                        mature = cohort_offset + horizon <= self.days
                        actual = (
                            sum(value for age, value in ages.items() if age < horizon)
                            if mature
                            else None
                        )
                        actual_roi = ratio(actual, cost) if mature else None
                        pred_roi = ratio(predicted, cost)
                        self.put(
                            "fact_roi_forecast_evaluation",
                            dict(
                                prediction_id=pid,
                                evaluation_as_of=self.end,
                                snapshot_date=self.dates[snap],
                                cohort_date=cohort,
                                app_id=app,
                                acquisition_country_code=country,
                                ua_channel_id=channel,
                                campaign_id=campaign,
                                horizon_days=horizon,
                                model_version=version,
                                revenue_source="sdk",
                            ),
                            attrs=dict(
                                predicted_roi_pct=pred_roi,
                                actual_revenue_usd=actual,
                                actual_cost_usd=cost if mature else None,
                                actual_roi_pct=actual_roi,
                                roi_error_pp=(
                                    (actual_roi - pred_roi) if mature else None
                                ),
                                cost_weight_usd=cost if mature else None,
                                maturity_state="mature" if mature else "immature",
                                input_revision_state="unchanged",
                                completeness_state="complete",
                            ),
                        )

    def creative_tests(self):
        deliveries = list(self.rows["fact_delivery_daily"].values())
        for creative in self.rows["dim_creative"].values():
            app, cid = creative["app_id"], creative["creative_id"]
            scopes = [
                ch
                for ch in ("breeze", "moss")
                if any(
                    r["creative_id"] == cid and r["ua_channel_id"] == ch
                    for r in deliveries
                )
            ]
            # One uploaded creative has an assigned test scope but no delivery;
            # another stays unassigned. Eligibility is not inferred from success.
            if not scopes and cid.endswith("_cr2"):
                scopes = ["breeze"]
            for channel in scopes or [None]:
                rows = [
                    r
                    for r in deliveries
                    if r["creative_id"] == cid and r["ua_channel_id"] == channel
                ]
                first = min((r["business_date"] for r in rows), default=None)
                within = (
                    [
                        r
                        for r in rows
                        if 0
                        <= (
                            date.fromisoformat(r["business_date"])
                            - date.fromisoformat(first)
                        ).days
                        < self.settings["policy"]["test_window_days"]
                    ]
                    if first
                    else []
                )
                observable = bool(
                    first
                    and (date.fromisoformat(self.end) - date.fromisoformat(first)).days
                    + 1
                    >= self.settings["policy"]["test_window_days"]
                )
                count = sum(r["af_registers"] for r in within)
                amount = sum(r["discounted_cost_usd"] for r in within)
                self.put(
                    "fact_creative_test_snapshot",
                    dict(
                        snapshot_date=self.end,
                        app_id=app,
                        creative_id=cid,
                        ua_channel_id=channel,
                    ),
                    attrs=dict(
                        first_test_date=first,
                        test_scope_state="assigned" if scopes else "unassigned",
                        is_eligible=int(bool(scopes)),
                        eligible_at=creative["upload_at"] if scopes else None,
                        is_tested=int(bool(first)),
                        is_observable=int(observable),
                        is_graduated=(
                            int(
                                count >= self.settings["policy"]["minimum_sample_units"]
                            )
                            if observable
                            else None
                        ),
                        rule_version="1",
                        test_window_cost_usd=amount,
                        test_window_registers=count,
                        test_window_revenue_usd=sum(
                            r["revenue_usd"]
                            for r in self.rows["fact_cohort_revenue_daily"].values()
                            if r["creative_id"] == cid
                            and r["ua_channel_id"] == channel
                            and r["revenue_source"] == "sdk"
                            and first
                            and 0
                            <= (
                                date.fromisoformat(r["cohort_date"])
                                - date.fromisoformat(first)
                            ).days
                            < self.settings["policy"]["test_window_days"]
                            and r["age_days"]
                            < self.settings["policy"]["test_window_days"]
                        ),
                        completeness_state="complete",
                    ),
                )

    def encoded(self, table):
        result = []
        for row in self.rows[table].values():
            encoded = {}
            for c in self.specs[table]["columns"]:
                v = row[c["name"]]
                if v is not None and "Decimal" in c["type"]:
                    v = (
                        money(v)
                        if c.get("unit") in {"USD", "原币"}
                        else format(Decimal(v).quantize(Decimal(".000001")), "f")
                    )
                encoded[c["name"]] = v
            result.append(encoded)
        return sorted(
            result,
            key=lambda r: json.dumps(
                [r[k] for k in ["dataset_version"] + self.specs[table]["dimensions"]],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )

    def late_cost(self):
        row = next(
            r
            for r in self.rows["fact_delivery_daily"].values()
            if r["discounted_cost_usd"] > 0
            and (
                date.fromisoformat(self.end) - date.fromisoformat(r["business_date"])
            ).days
            >= 7
        )
        delta = 500_000
        rate = next(
            r["source_currency_per_usd"]
            for r in self.rows["fact_fx_rate_daily"].values()
            if r["rate_date"] == row["business_date"]
            and r["source_currency"] == row["source_currency"]
        )
        for key in ("raw_cost_usd", "discounted_cost_usd"):
            row[key] += delta
        for key in ("raw_cost_local", "discounted_cost_local"):
            row[key] += delta * int(rate)
        self.oracle["discounted_cost_usd"] += delta
        group = (
            row["business_date"],
            row["app_id"],
            row["acquisition_country_code"],
            row["ua_channel_id"],
            row["campaign_id"],
        )
        new_cost = self.forecast_cost[group] + delta
        for evaluation in self.rows["fact_roi_forecast_evaluation"].values():
            key = tuple(
                evaluation[k]
                for k in (
                    "cohort_date",
                    "app_id",
                    "acquisition_country_code",
                    "ua_channel_id",
                    "campaign_id",
                )
            )
            if key != group:
                continue
            evaluation["input_revision_state"] = "input_revised"
            evaluation["roi_error_pp"] = None
            evaluation["cost_weight_usd"] = None
            if evaluation["maturity_state"] == "mature":
                evaluation["actual_cost_usd"] = new_cost
                evaluation["actual_roi_pct"] = ratio(
                    evaluation["actual_revenue_usd"], new_cost
                )


def generate(
    output,
    profile="demo",
    end="2026-11-08",
    seed=20261108,
    days=None,
    installs=None,
    scenario="clean",
    row_budget=None,
    start_date=None,
):
    output = Path(output).resolve()
    if output.exists():
        raise ValueError("output_exists: use a new immutable output directory")
    settings = json.loads((ROOT / "settings.json").read_text())
    selected = settings["profiles"][profile]
    days = selected["days"] if days is None else days
    installs = selected["installs_per_app_day"] if installs is None else installs
    if not 14 <= days <= 730 or not 1 <= installs <= 100:
        raise ValueError("days must be 14..730 and installs must be 1..100")
    if days * installs * 6 > settings["device_budget"]:
        raise ValueError("private_device_budget_exceeded")
    if scenario not in {
        "clean",
        "null_cost",
        "missing_day",
        "duplicate_dimension",
        "late_cost",
    }:
        raise ValueError("unsupported_scenario")
    start = (
        date.fromisoformat(start_date)
        if start_date
        else date.fromisoformat(end) - timedelta(days=days - 1)
    )
    budget = (
        selected.get("row_budget", settings["row_budget"])
        if row_budget is None
        else row_budget
    )
    if not 1 <= budget <= 5_000_000:
        raise ValueError("row_budget must be 1..5000000")
    if start < date(2020, 1, 1) or start + timedelta(days=days - 1) > date(
        2099, 12, 31
    ):
        raise ValueError("date_outside_contract_validity")
    world = World(settings, start, days, installs, seed, scenario, budget)
    world.dim()
    world.simulate()
    world.complete_series()
    world.forecasts()
    if scenario == "late_cost":
        world.late_cost()
    world.creative_tests()
    total_rows = sum(map(len, world.rows.values()))
    if total_rows > budget:
        raise ValueError("published_row_budget_exceeded")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".starhaven-build-", dir=output.parent))
    try:
        tables = {}
        for table in sorted(world.rows):
            rows = world.encoded(table)
            original_count = len(rows)
            if scenario == "null_cost" and table == "fact_delivery_daily":
                rows[0]["discounted_cost_usd"] = None
                rows[0]["completeness_state"] = "partial"
            elif scenario == "missing_day" and table == "fact_delivery_daily":
                day = world.dates[len(world.dates) // 2]
                rows = [row for row in rows if row["business_date"] != day]
            elif scenario == "duplicate_dimension" and table == "dim_app":
                rows.append(dict(rows[0], game_name="重复维键故障"))
            data = "".join(
                json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                for row in rows
            )
            path = stage / (table + ".jsonl")
            path.write_text(data)
            tables[table] = dict(
                rows=len(rows),
                expected_rows=original_count,
                sha256=hashlib.sha256(data.encode()).hexdigest(),
                bytes=len(data.encode()),
            )
        gold = {
            key: money(value) if key.endswith("_usd") else value
            for key, value in sorted(world.oracle.items())
        }
        windows = [
            dict(app_id=app, window_days=window, devices=len(values))
            for (app, window), values in sorted(world.window_oracle.items())
        ]
        (stage / "private-gold.json").write_text(
            json.dumps(
                dict(
                    totals=gold,
                    private_devices=world.private_device_count,
                    window_oracles=windows,
                ),
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        manifest = dict(
            schema_version="starhaven-v1",
            dataset_version=world.version,
            seed=seed,
            start_date=world.dates[0],
            as_of=world.end,
            days=days,
            installs_per_app_day=installs,
            scenario=scenario,
            config_sha256=world.config_hash,
            implementation_sha256=world.implementation_hash,
            tables=tables,
            private_identifiers_exported=False,
            publication="unpublished_offline_dataset",
            row_budget=budget,
        )
        (stage / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        )
        os.replace(stage, output)
        return manifest
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
