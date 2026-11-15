import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import server


class InvestmentProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.origin = {'Origin': 'http://localhost'}
        self.key_file = tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', delete=False)
        self.key_file.write('test-only-key')
        self.key_file.close()
        self.addCleanup(os.unlink, self.key_file.name)
        self.key_patch = patch.object(server, 'TWELVE_DATA_KEY_PATH', self.key_file.name)
        self.key_patch.start()
        self.addCleanup(self.key_patch.stop)

    def post(self, payload, headers=None, **kwargs):
        return self.client.post('/api/investments/market-data', json=payload,
                                headers=self.origin if headers is None else headers, **kwargs)

    def test_reads_key_on_server_and_returns_only_quote_fields(self):
        response_data = {'close': '123', 'currency': 'USD', 'private': 'not returned'}
        with patch.object(server, 'urlopen', return_value=io.BytesIO(json.dumps(response_data).encode())) as fetch:
            response = self.post({'path': 'quote', 'params': {'symbol': 'AAPL', 'mic_code': 'XNGS'}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['close'], '123')
        self.assertNotIn('private', response.json)
        self.assertNotIn('test-only-key', response.get_data(as_text=True))
        url = urlsplit(fetch.call_args.args[0])
        self.assertEqual(url.hostname, 'api.twelvedata.com')
        self.assertEqual(parse_qs(url.query)['apikey'], ['test-only-key'])

    def test_rejects_cross_origin_nonlocal_and_invalid_parameters(self):
        payload = {'path': 'quote', 'params': {'symbol': 'AAPL'}}
        with patch.object(server, 'urlopen') as fetch:
            self.assertEqual(self.post(payload, headers={'Origin': 'https://example.com'}).status_code, 403)
            self.assertEqual(self.post(payload, environ_base={'REMOTE_ADDR': '192.0.2.1'}).status_code, 403)
            self.assertEqual(self.post({'path': 'quote', 'params': {'symbol': 'AAPL', 'apikey': 'override'}}).status_code, 400)
            self.assertEqual(self.post({'path': '../quote', 'params': {'symbol': 'AAPL'}}).status_code, 400)
            fetch.assert_not_called()

    def test_missing_key_and_provider_errors_are_explicit_without_disclosing_key(self):
        payload = {'path': 'quote', 'params': {'symbol': 'AAPL'}}
        with patch.object(server, 'TWELVE_DATA_KEY_PATH', self.key_file.name + '.missing'):
            self.assertEqual(self.post(payload).status_code, 503)
        with patch.object(server, 'urlopen', return_value=io.BytesIO(b'{"status":"error","code":429,"message":"test-only-key"}')):
            response = self.post(payload)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('test-only-key', response.get_data(as_text=True))

    def test_rejects_key_file_with_multiple_fields(self):
        with open(self.key_file.name, 'w', encoding='utf-8') as key_file:
            key_file.write('one,two')
        with patch.object(server, 'urlopen') as fetch:
            self.assertEqual(self.post({'path': 'quote', 'params': {'symbol': 'AAPL'}}).status_code, 503)
            fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
