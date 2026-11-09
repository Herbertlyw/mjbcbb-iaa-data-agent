"""Exercise local transport boundaries and error redaction without credentials."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
import unittest

from synthetic.starhaven.load import ClickHouseHttpError, LocalHttp


class LocalTransportTests(unittest.TestCase):
    def test_only_explicit_loopback_ports_are_accepted(self):
        for url in [
            "https://127.0.0.1:8123",
            "http://localhost:8123",
            "http://127.0.0.1",
            "http://192.168.1.2:8123",
            "http://127.0.0.1:8123/?query=SELECT",
            "http://user:secret@127.0.0.1:8123",
            "http://127.0.0.1:8123/somewhere",
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                LocalHttp(url, "fictional", "fictional")

    def test_server_echoes_and_redirects_do_not_escape(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if body == b"redirect":
                    self.send_response(307)
                    self.send_header("Location", "http://example.invalid:8123/")
                    self.end_headers()
                    return
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"Code: 164. READONLY. echoed-fictional-secret")

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            client = LocalHttp(
                "http://127.0.0.1:" + str(server.server_port), "fictional", "fictional"
            )
            with self.assertRaises(ClickHouseHttpError) as caught:
                client.request("error")
            self.assertEqual(caught.exception.server_code, 164)
            self.assertNotIn("echoed-fictional-secret", str(caught.exception))
            with self.assertRaisesRegex(ValueError, "clickhouse_redirect_forbidden"):
                client.request("redirect")
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
