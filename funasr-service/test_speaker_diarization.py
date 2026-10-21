import unittest
import tempfile
import wave
from pathlib import Path

from speaker_diarization import acoustic_turns, attach_voiceprints, split_sentence


class SpeakerTurnTests(unittest.TestCase):
    def row(self, text='怎么做？我负责。', timestamp=None):
        return {'id': 's', 'speakerId': 'speaker_0', 'text': text,
                'startMs': 0, 'endMs': 6000, **({'timestamp': timestamp} if timestamp is not None else {})}

    def test_splits_a_mixed_sentence_at_word_timestamps_without_changing_text(self):
        row = self.row(timestamp=[[0, 500], [500, 1000], [1000, 1500],
                                  [3000, 3500], [3500, 4000], [4000, 4500]])
        rows = split_sentence(row, [[0, 2, 0], [3, 6, 1]])
        self.assertEqual([r['text'] for r in rows], ['怎么做？', '我负责。'])
        self.assertEqual([r['speakerId'] for r in rows], ['speaker_0', 'speaker_1'])
        self.assertEqual(''.join(r['text'] for r in rows), row['text'])
        self.assertEqual([(r['startMs'], r['endMs']) for r in rows], [(0, 1500), (3000, 4500)])
        self.assertTrue(all(r['speakerVerified'] for r in rows))
        self.assertNotEqual(rows[0]['id'], rows[1]['id'])

    def test_missing_or_mismatched_timestamps_never_invent_a_split(self):
        for timestamps in [None, [], [[0, 1000]], [[-1, 1]] * 6, [[float('nan'), 1]] * 6]:
            row = self.row(timestamp=timestamps)
            rows = split_sentence(row, [[0, 2, 0], [3, 6, 1]])
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['text'], row['text'])
            self.assertTrue(rows[0]['speakerMixed'])
            self.assertFalse(rows[0]['speakerVerified'])

    def test_uses_acoustic_identity_not_original_sentence_label(self):
        rows = split_sentence(self.row(), [[0, 6, 2]])
        self.assertEqual(rows[0]['speakerId'], 'speaker_2')
        self.assertTrue(rows[0]['speakerVerified'])

    def test_no_matching_audio_turn_is_not_verified(self):
        rows = split_sentence(self.row(), [[7, 8, 0]])
        self.assertFalse(rows[0]['speakerVerified'])

    def test_chinese_english_surface_tokens_preserve_spaces_and_punctuation(self):
        row = self.row('用 Redis？我用缓存。', [[0, 500], [500, 1000], [3000, 3500], [3500, 4000], [4000, 4500], [4500, 5000]])
        rows = split_sentence(row, [[0, 2, 0], [3, 6, 1]])
        self.assertEqual([r['text'] for r in rows], ['用 Redis？', '我用缓存。'])

    def test_missing_speaker_model_does_not_stop_transcription_or_claim_a_verified_voice(self):
        row = self.row()
        result = attach_voiceprints(object(), 'nonexistent.wav', [row])
        self.assertEqual(result[0]['text'], row['text'])
        self.assertFalse(result[0]['speakerVerified'])

    def test_word_on_uncertain_speaker_boundary_is_not_forced_to_either_voice(self):
        row = self.row('甲乙', [[0, 1000], [1000, 2000]])
        rows = split_sentence(row, [[0, 0.5, 0], [0.5, 2, 1]])
        self.assertEqual(len(rows), 2)
        self.assertEqual(''.join(r['text'] for r in rows), row['text'])
        self.assertTrue(rows[0]['speakerMixed'])
        self.assertFalse(rows[0]['speakerVerified'])
        self.assertEqual(rows[1]['speakerId'], 'speaker_1')
        self.assertTrue(rows[1]['speakerVerified'])

    def test_short_interruption_is_not_reassigned_to_neighbor(self):
        turns = acoustic_turns([[0, 1.5], [0.75, 1.85], [1.5, 3]], [0, 1, 0])
        self.assertEqual([turn[2] for turn in turns], [0, 1, 0])
        self.assertGreater(turns[1][1] - turns[1][0], 0)
        self.assertLess(turns[1][1] - turns[1][0], 0.7)

    def test_sparse_single_voice_evidence_cannot_verify_entire_sentence(self):
        rows = split_sentence(self.row(), [[0, 0.2, 0]])
        self.assertFalse(rows[0]['speakerVerified'])

    def test_recovery_text_is_not_promoted_to_a_verified_single_speaker(self):
        row = {**self.row(), 'speakerMixed': True, 'speakerVerified': False}
        result = split_sentence(row, [[0, 6, 0]])
        self.assertFalse(result[0]['speakerVerified'])
        self.assertTrue(result[0]['speakerMixed'])

    def test_simultaneous_voices_are_not_forced_to_one_speaker(self):
        rows = split_sentence(self.row('甲乙', [[0, 1000], [1000, 2000]]), [[0, 2, 0], [0, 2, 1]])
        self.assertEqual(''.join(row['text'] for row in rows), '甲乙')
        self.assertTrue(all(not row['speakerVerified'] for row in rows))

    def test_one_uncertain_word_does_not_erase_two_clear_speaker_groups(self):
        row = self.row('甲乙丙丁', [[0, 500], [500, 1000], [1000, 1500], [1500, 2000]])
        rows = split_sentence(row, [[0, 0.7, 0], [0.8, 2, 1]])
        self.assertEqual([r['text'] for r in rows], ['甲', '乙', '丙丁'])
        self.assertEqual([r['speakerVerified'] for r in rows], [True, False, True])
        self.assertEqual(''.join(r['text'] for r in rows), row['text'])

    def test_voice_vectors_follow_corrected_cluster_ids_through_acoustic_turns(self):
        import numpy as np
        import torch

        class Model:
            spk_model = object()
            spk_kwargs = {}

            def inference(self, inputs, **kwargs):
                return [{'spk_embedding': torch.tensor([[1., 0.] if i < 3 else [0., 1.]])}
                        for i, _ in enumerate(inputs)]

            def cb_model(self, embeddings, **kwargs):
                return np.array([7 if i < 3 else 9 for i in range(len(embeddings))])

        row = self.row(timestamp=[[0, 500], [500, 1000], [1000, 1500],
                                  [3000, 3500], [3500, 4000], [4000, 4500]])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.wav'
            with wave.open(str(path), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(bytes(6 * 16000 * 2))
            rows = attach_voiceprints(Model(), path, [row])
        self.assertEqual([r['speakerId'] for r in rows], ['speaker_0', 'speaker_1'])
        self.assertEqual([r['speakerEmbedding'] for r in rows], [[1., 0.], [0., 1.]])
        self.assertEqual(''.join(r['text'] for r in rows), row['text'])


if __name__ == '__main__':
    unittest.main()
