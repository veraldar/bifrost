"""Hand-computed cases for wt.method (plan.md step 5)."""
import math
import random
import unittest

from wt import method as M


def annual(vals, start=2000, skip=()):
    return [(str(start + i), f"{start + i}-12-31", float(v)) for i, v in enumerate(vals) if start + i not in skip]


class TestPct(unittest.TestCase):
    def test_pct_and_direction(self):
        self.assertAlmostEqual(M.pct([1, 2, 3, 4], 3), 0.625)  # (2 + 0.5) / 4
        self.assertAlmostEqual(1 - M.pct([1, 2, 3, 4], 3), 0.375)  # dir −1

    def test_direction_via_rank_level(self):
        rows = annual([1, 2, 3, 4, 5, 6, 7, 8, 4.5])  # R = 1..8, y* = 4.5 → 4/8
        up = M.score("rank_level", rows, "annual", {"diff": "abs", "h": "30"}, +1)
        dn = M.score("rank_level", rows, "annual", {"diff": "abs", "h": "30"}, -1)
        self.assertEqual(up["score"], 0.5)
        self.assertEqual(up["ref_n"], 8)
        rows = annual([1, 2, 3, 4, 5, 6, 7, 8, 3])  # 2 below + 1 tie → 2.5/8
        self.assertEqual(M.score("rank_level", rows, "annual", {"diff": "abs", "h": "30"}, +1)["score"], 0.3125)
        self.assertEqual(M.score("rank_level", rows, "annual", {"diff": "abs", "h": "30"}, -1)["score"], 0.6875)
        self.assertEqual(dn["score"], 0.5)


class TestRankDelta(unittest.TestCase):
    def test_missing_year_not_interpolated(self):
        vals = [math.exp(i * 0.1) for i in range(15)]
        rows = annual(vals, skip=(2005,))
        fx = M.prepare(rows, "annual", {"diff": "log"})
        ys = {t: fx[t] - fx[t - 1] for t in fx if t - 1 in fx}
        self.assertNotIn(2005, ys)   # year missing
        self.assertNotIn(2006, ys)   # its delta is undefined, not interpolated
        self.assertEqual(len(ys), 12)  # 14 rows → 13 deltas → minus 2006
        for y in ys.values():
            self.assertAlmostEqual(y, 0.1)

    def test_latest_delta_undefined_is_no_value(self):
        rows = annual(range(1, 15), skip=(2012,))  # latest 2013, its lag row 2012 missing
        with self.assertRaises(M.Excluded) as c:
            M.score("rank_delta", rows, "annual", {"lag": "1", "diff": "abs", "h": "30"}, 1)
        self.assertEqual(c.exception.reason, "no_value")


class TestHistoryFloor(unittest.TestCase):
    def test_annual_seven_is_short(self):
        rows = annual(range(1, 9))  # 8 levels → R = 7 before y*
        with self.assertRaises(M.Excluded) as c:
            M.score("rank_level", rows, "annual", {"diff": "abs", "h": "30"}, 1)
        self.assertEqual(c.exception.reason, "short_history")
        self.assertEqual(c.exception.detail, "ref_n 7 < 8")

    def test_h_caps_reference(self):
        rows = annual(range(1, 50))
        self.assertEqual(M.score("rank_level", rows, "annual", {"diff": "abs", "h": "30"}, 1)["ref_n"], 30)


class TestLogistic(unittest.TestCase):
    def rows(self, d):
        # two points 365.25-day-equivalent apart: use 365 days, scale d accordingly
        return [("2024-01-01", "2024-01-01", 10.0), ("2024-12-31", "2024-12-31", 10.0 + d * 365 / 365.25)]

    def test_d_equals_d0(self):
        r = M.score("logistic_delta", self.rows(2.0), "daily", {"span_days": "300", "diff": "abs", "d0": "2", "k": "5"}, 1)
        self.assertEqual(r["score"], 0.5)

    def test_d0_plus_k(self):
        r = M.score("logistic_delta", self.rows(7.0), "daily", {"span_days": "300", "diff": "abs", "d0": "2", "k": "5"}, 1)
        self.assertEqual(r["score"], 0.7311)
        r = M.score("logistic_delta", self.rows(7.0), "daily", {"span_days": "300", "diff": "abs", "d0": "2", "k": "5"}, -1)
        self.assertEqual(r["score"], 0.2689)

    def test_no_ref_is_short_history(self):
        with self.assertRaises(M.Excluded) as c:
            M.score("logistic_delta", self.rows(1), "daily", {"span_days": "400", "diff": "abs", "d0": "0", "k": "1"}, 1)
        self.assertEqual(c.exception.reason, "short_history")

    def test_logit_clamp(self):
        self.assertAlmostEqual(M.f_scale(100.0, "logit"), math.log(99.5 / 0.5))
        self.assertAlmostEqual(M.f_scale(0.0, "logit"), math.log(0.5 / 99.5))
        self.assertAlmostEqual(M.f_scale(50.0, "logit"), 0.0)


class TestAggregation(unittest.TestCase):
    def test_all_neutral(self):
        e = {}
        for k, wm in zip(M.REALMS, [7, 7, 3, 2, 5, 5, 4]):
            e[k] = M.aggregate([(3, 0.5), (2, 0.5)], wm)["evidence"]
        self.assertTrue(all(v == 0.5 for v in e.values()))

    def test_mass_shrink(self):
        a = M.aggregate([(2, 1.0)], 4)
        self.assertAlmostEqual(a["mass"], 1 / 3)
        self.assertEqual(round(a["evidence"], 4), 0.6667)
        self.assertEqual(a["coverage"], 0.5)

    def test_empty_realm_is_neutral(self):
        a = M.aggregate([], 5)
        self.assertEqual(a["evidence"], 0.5)
        self.assertEqual(a["coverage"], 0.0)

    def test_contributions_sum_to_evidence(self):
        used = [(3, 0.9), (2, 0.2), (1, 0.66)]
        a = M.aggregate(used, 7)
        c = sum(M.contribution(w, s, a["mass"], a["w_used"]) for w, s in used)
        self.assertAlmostEqual(c, a["evidence"] - 0.5)


class TestRounding(unittest.TestCase):
    def test_equal(self):
        w = M.largest_remainder({k: 0.5 for k in M.REALMS})
        self.assertEqual([w[k] for k in M.REALMS], [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2])
        self.assertEqual(list(w), M.REALMS)

    def test_random_sums_to_1000(self):
        rnd = random.Random(7)
        for _ in range(2000):
            e = {k: rnd.random() for k in M.REALMS}
            w = M.largest_remainder(e)
            self.assertEqual(sum(round(v * 10) for v in w.values()), 1000)


if __name__ == "__main__":
    unittest.main()
