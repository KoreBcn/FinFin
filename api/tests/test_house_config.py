import json
import os
import tempfile
import unittest
from unittest.mock import patch

import server


class HouseConfigTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        config = tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', delete=False)
        json.dump({'installment_concept': 'test payment', 'interest_concept': 'test interest'}, config)
        config.close()
        self.addCleanup(os.unlink, config.name)
        config_patch = patch.object(server, 'HOUSE_CONFIG_PATH', config.name)
        config_patch.start()
        self.addCleanup(config_patch.stop)

    def post(self, **kwargs):
        return self.client.post('/api/investments/house-config', json={}, **kwargs)

    def test_reads_local_config_without_caching(self):
        response = self.post(headers={'Origin': 'http://localhost'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {'installment_concept': 'test payment', 'interest_concept': 'test interest'})
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_rejects_cross_origin_and_nonlocal_requests(self):
        self.assertEqual(self.post(headers={'Origin': 'https://example.com'}).status_code, 403)
        self.assertEqual(self.post(headers={'Origin': 'http://localhost'}, environ_base={'REMOTE_ADDR': '192.0.2.1'}).status_code, 403)

    def test_missing_or_invalid_config_is_reported(self):
        with patch.object(server, 'HOUSE_CONFIG_PATH', 'missing-house-config.json'):
            self.assertEqual(self.post(headers={'Origin': 'http://localhost'}).status_code, 503)
        with open(server.HOUSE_CONFIG_PATH, 'w', encoding='utf-8') as config:
            config.write('{}')
        self.assertEqual(self.post(headers={'Origin': 'http://localhost'}).status_code, 503)
        with open(server.HOUSE_CONFIG_PATH, 'w', encoding='utf-8') as config:
            json.dump({'installment_concept': 'test payment'}, config)
        self.assertEqual(self.post(headers={'Origin': 'http://localhost'}).status_code, 503)
        with open(server.HOUSE_CONFIG_PATH, 'w', encoding='utf-8') as config:
            json.dump({'installment_concept': 'test payment', 'interest_concept': 'PAYMENT'}, config)
        self.assertEqual(self.post(headers={'Origin': 'http://localhost'}).status_code, 503)


if __name__ == '__main__':
    unittest.main()
