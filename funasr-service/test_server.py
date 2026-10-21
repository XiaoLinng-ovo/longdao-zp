import threading
import time
import unittest
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import server


class NormalizationTests(unittest.TestCase):
    def test_small_native_timestamps_are_milliseconds(self):
        row = server._normalize_result({'text': '完整回答', 'start': 50, 'end': 90}, 15000)[0]
        self.assertEqual((row['startMs'], row['endMs']), (50, 90))

    def test_multiple_results_keep_every_sentence(self):
        rows = server._normalize_result([
            {'text': '第一句第二句', 'sentence_info': [{'text': '第一句', 'start': 50, 'end': 900}, {'text': '第二句', 'start': 1000, 'end': 1900}]},
            {'sentence_info': [{'text': '第三句', 'start': 2000, 'end': 2900}]},
        ], 3000)
        self.assertEqual([row['text'] for row in rows], ['第一句', '第二句', '第三句'])

    def test_long_text_is_not_truncated(self):
        text = '我负责招聘平台开发和数据库管理。' * 1000
        self.assertEqual(server._normalize_result({'text': text}, 300000)[0]['text'], text)

    def test_incomplete_sentence_info_never_replaces_full_recognition(self):
        text = '您好，请介绍一下项目经历。之后是否需要回学校？'
        rows = server._normalize_result({'text': text, 'sentence_info': [
            {'text': '好。', 'start': 0, 'end': 100},
        ]}, 15000)
        self.assertEqual(''.join(row['text'] for row in rows), text)
        self.assertEqual((rows[0]['startMs'], rows[0]['endMs']), (0, 15000))

    def test_punctuation_differences_keep_complete_sentence_boundaries(self):
        rows = server._normalize_result({'text': '您好，请介绍项目。', 'sentence_info': [
            {'text': '您好。', 'start': 100, 'end': 500},
            {'text': '请介绍项目。', 'start': 700, 'end': 1400},
        ]}, 1500)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]['startMs'], 700)

    def test_incomplete_sentence_fallback_retains_real_word_timestamps(self):
        timestamps = [[0, 200], [200, 400], [500, 700], [700, 900]]
        rows = server._normalize_result({'text': '甲乙丙丁', 'timestamp': timestamps,
                                         'sentence_info': [{'text': '甲', 'start': 0, 'end': 200}]}, 1000)
        self.assertEqual(rows[0]['text'], '甲乙丙丁')
        self.assertEqual(rows[0]['timestamp'], timestamps)

    def test_text_disagreement_without_word_timing_keeps_one_complete_unknown_transcript(self):
        rows = server._normalize_result({'text': '请介绍经历。我负责开发和测试。', 'sentence_info': [
            {'text': '请介绍经历。', 'start': 0, 'end': 900, 'spk': 0},
            {'text': '我负责开发。', 'start': 1000, 'end': 1900, 'spk': 1},
        ]}, 3000)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['text'], '请介绍经历。我负责开发和测试。')
        self.assertEqual((rows[0]['startMs'], rows[0]['endMs']), (0, 3000))
        self.assertFalse(rows[0]['speakerVerified'])
        self.assertTrue(rows[0]['speakerMixed'])

    def test_concurrent_offline_calls_do_not_share_mutable_model_state(self):
        active = 0
        maximum = 0
        guard = threading.Lock()

        class Model:
            def generate(self, **kwargs):
                nonlocal active, maximum
                with guard:
                    active += 1
                    maximum = max(maximum, active)
                time.sleep(0.02)
                with guard:
                    active -= 1
                return [{'text': '完整回答', 'start': 0, 'end': 1000}]

        with patch.object(server, 'get_model', return_value=Model()), patch.object(server, '_wav_duration_ms', return_value=1000):
            with ThreadPoolExecutor(max_workers=4) as executor:
                results = list(executor.map(server._transcribe_sync, [Path('test.wav')] * 4))
        self.assertEqual(maximum, 1)
        self.assertTrue(all(result[0]['text'] == '完整回答' for result in results))

    def test_acoustic_failure_keeps_text_but_removes_scoring_eligibility_and_internal_timing(self):
        class Model:
            def generate(self, **kwargs):
                return [{'text': '我负责系统开发。', 'start': 0, 'end': 1000, 'timestamp': [[0, 1000]]}]

        with patch.object(server, 'get_model', return_value=Model()), \
                patch.object(server, '_wav_duration_ms', return_value=1000), \
                patch.object(server, 'attach_voiceprints', side_effect=RuntimeError('test failure')), \
                self.assertLogs('funasr-service', level='ERROR'):
            rows = server._transcribe_sync(Path('test.wav'))
        self.assertEqual(rows[0]['text'], '我负责系统开发。')
        self.assertFalse(rows[0]['speakerVerified'])
        self.assertNotIn('timestamp', rows[0])

    def test_health_exposes_whether_the_speaker_model_is_actually_loaded(self):
        with patch.object(server, '_model', object()), patch.object(server, '_cuda_available', return_value=False):
            self.assertFalse(server.health()['speakerModelLoaded'])
        class Model:
            spk_model = object()
        with patch.object(server, '_model', Model()), patch.object(server, '_cuda_available', return_value=False):
            self.assertTrue(server.health()['speakerModelLoaded'])


class StreamingCommitTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_echoes_chunk_identity_and_rotates_text_between_commits(self):
        class Socket:
            def __init__(self):
                self.messages = deque([
                    {'text': '{"type":"ping"}'},
                    {'text': '{"type":"commit","commitId":"first"}'},
                    {'text': '{"type":"ping"}'},
                    {'text': '{"type":"commit","commitId":"second"}'},
                    {'text': '{"type":"end"}'},
                ])
                self.sent = []
                self.closed = False

            async def accept(self):
                pass

            async def receive(self):
                return self.messages.popleft()

            async def send_json(self, value):
                self.sent.append(value)

            async def close(self, code):
                self.closed = True

        socket = Socket()
        with patch.object(server, 'get_streaming_model', return_value=object()), \
                patch.object(server, '_generate_streaming_sync', side_effect=['Project question and answer.', 'School question and answer.', '']) as generate:
            await server.stream_transcription(socket)
        self.assertIn({'type': 'status', 'status': 'ready', 'heartbeat': True}, socket.sent)
        self.assertEqual([message for message in socket.sent if message['type'] == 'pong'], [{'type': 'pong'}, {'type': 'pong'}])
        self.assertEqual(generate.call_count, 3)
        finals = [message for message in socket.sent if message['type'] == 'final']
        self.assertEqual(finals, [
            {'type': 'final', 'text': 'Project question and answer.', 'commitId': 'first'},
            {'type': 'final', 'text': 'School question and answer.', 'commitId': 'second'},
            {'type': 'final', 'text': ''},
        ])
        self.assertTrue(socket.closed)


if __name__ == '__main__':
    unittest.main()
