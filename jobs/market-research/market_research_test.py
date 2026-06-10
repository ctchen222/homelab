import json
import tempfile
import unittest
from pathlib import Path

from market_research import build_report


class MarketResearchTest(unittest.TestCase):
    def test_generates_report_from_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            watchlist = base / "watchlist.json"
            fixture = base / "fixture.json"
            output = base / "report.json"

            watchlist.write_text(
                json.dumps(
                    {
                        "timezone": "Asia/Taipei",
                        "symbols": [
                            {
                                "market": "TWSE",
                                "ticker": "2330",
                                "displayName": "TSMC",
                                "currency": "TWD",
                                "dataSource": "twse-openapi",
                                "providerSymbol": "2330",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            fixture.write_text(
                json.dumps(
                    {
                        "2330": {
                            "currentPrice": 1000,
                            "previousReferencePrice": 980,
                        }
                    }
                ),
                encoding="utf-8",
            )

            report = build_report(watchlist, output, fixture)

            self.assertEqual(report["status"], "ok")
            self.assertEqual(report["symbols"][0]["ticker"], "2330")
            self.assertGreater(report["symbols"][0]["changePercent"], 0)
            self.assertIn("Research commentary only", report["symbols"][0]["commentary"])

    def test_marks_missing_provider_as_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            watchlist = base / "watchlist.json"
            output = base / "report.json"

            watchlist.write_text(
                json.dumps(
                    {
                        "timezone": "Asia/Taipei",
                        "symbols": [
                            {
                                "market": "TWSE",
                                "ticker": "0000",
                                "displayName": "Missing",
                                "currency": "TWD",
                                "dataSource": "twse-openapi",
                                "providerSymbol": "0000",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            report = build_report(watchlist, output, None, fetcher=lambda _url: [])

            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["symbols"][0]["currentPrice"], None)

    def test_marks_unavailable_provider_as_partial_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            watchlist = base / "watchlist.json"
            output = base / "report.json"

            watchlist.write_text(
                json.dumps(
                    {
                        "timezone": "Asia/Taipei",
                        "symbols": [
                            {
                                "market": "NASDAQ",
                                "ticker": "QQQ",
                                "displayName": "Invesco QQQ",
                                "currency": "USD",
                                "dataSource": "openbb-yfinance",
                                "providerSymbol": "QQQ",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            def unavailable_fetcher(_url):
                raise TimeoutError("provider timeout")

            report = build_report(watchlist, output, None, fetcher=unavailable_fetcher)

            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["symbols"][0]["currentPrice"], None)
            self.assertIn("provider unavailable", report["symbols"][0]["notes"][0])

    def test_marks_stale_fixture_as_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            watchlist = base / "watchlist.json"
            fixture = base / "fixture.json"
            output = base / "report.json"

            watchlist.write_text(
                json.dumps(
                    {
                        "timezone": "Asia/Taipei",
                        "report": {"riskDisclosure": "Research commentary only."},
                        "symbols": [
                            {
                                "market": "NASDAQ",
                                "ticker": "QQQ",
                                "displayName": "Invesco QQQ",
                                "currency": "USD",
                                "dataSource": "openbb-yfinance",
                                "providerSymbol": "QQQ",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            fixture.write_text(
                json.dumps(
                    {
                        "QQQ": {
                            "currentPrice": 500,
                            "previousReferencePrice": 501,
                            "stale": True,
                        }
                    }
                ),
                encoding="utf-8",
            )

            report = build_report(watchlist, output, fixture)

            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["symbols"][0]["stale"], True)
            self.assertEqual(report["riskDisclosure"], "Research commentary only.")


if __name__ == "__main__":
    unittest.main()
