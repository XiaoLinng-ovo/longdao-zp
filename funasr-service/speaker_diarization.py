"""Retain acoustic turn boundaries instead of assigning one speaker per sentence."""
from __future__ import annotations

import math
import re
import wave
from typing import Any


def acoustic_turns(windows: list[list[Any]], labels: Any) -> list[list[Any]]:
    """Resolve sliding-window overlap without erasing short speaker turns."""
    turns: list[list[Any]] = []
    for window, label in zip(windows, labels):
        start, end, speaker = float(window[0]), float(window[1]), int(label)
        if end <= start:
            continue
        if turns and turns[-1][2] == speaker and start <= turns[-1][1]:
            turns[-1][1] = max(turns[-1][1], end)
        else:
            turns.append([start, end, speaker])
    for index in range(1, len(turns)):
        previous, current = turns[index - 1], turns[index]
        if previous[1] > current[0]:
            boundary = (previous[1] + current[0]) / 2
            previous[1] = current[0] = boundary
    return turns


def _coverage(start: float, end: float, intervals: list[list[Any]]) -> float:
    ranges = sorted((max(start, turn[0] * 1000), min(end, turn[1] * 1000))
                    for turn in intervals if turn[0] * 1000 < end and turn[1] * 1000 > start)
    covered, right = 0.0, start
    for left, stop in ranges:
        covered += max(0, stop - max(left, right))
        right = max(right, stop)
    return covered


def split_sentence(row: dict[str, Any], turns: list[list[Any]]) -> list[dict[str, Any]]:
    if row.get('speakerMixed'):
        return [{**row, 'speakerVerified': False}]
    text = str(row.get('text', ''))
    start, end = row['startMs'], row['endMs']
    relevant = [turn for turn in turns if turn[0] * 1000 < end and turn[1] * 1000 > start]
    labels = {int(turn[2]) for turn in relevant}
    if not relevant:
        return [{**row, 'speakerVerified': False}]
    if len(labels) == 1 and _coverage(start, end, relevant) >= (end - start) * 0.9:
        return [{**row, 'speakerId': f'speaker_{next(iter(labels))}', 'speakerVerified': True, 'speakerMixed': False}]

    timestamps = row.get('timestamp')
    tokens = list(re.finditer(r'[A-Za-z0-9]+|[^\W_]', text))
    # Never guess a text split from character lengths or invent word timestamps.
    if not isinstance(timestamps, list) or len(timestamps) != len(tokens) or not tokens:
        return [{**row, 'speakerVerified': False, 'speakerMixed': True}]
    if any(not isinstance(ts, (list, tuple)) or len(ts) != 2
           or not all(isinstance(n, (int, float)) and math.isfinite(n) for n in ts)
           or ts[1] < ts[0] or ts[0] < start or ts[1] > end for ts in timestamps):
        return [{**row, 'speakerVerified': False, 'speakerMixed': True}]
    groups: list[tuple[int, int, int | None]] = []
    for index, ts in enumerate(timestamps):
        overlaps = sorted((_coverage(ts[0], ts[1], [turn for turn in relevant if int(turn[2]) == label]), label)
                          for label in labels)
        overlap, best = overlaps[-1]
        competing = overlaps[-2][0] if len(overlaps) > 1 else 0
        duration = ts[1] - ts[0]
        speaker = best if duration > 0 and overlap >= duration * 0.8 and competing <= duration * 0.1 else None
        if groups and groups[-1][2] == speaker:
            groups[-1] = (groups[-1][0], index, speaker)
        else:
            groups.append((index, index, speaker))
    result = []
    for index, (first, last, speaker) in enumerate(groups):
        left = 0 if first == 0 else tokens[first].start()
        right = tokens[last + 1].start() if last + 1 < len(tokens) else len(text)
        result.append({**row, 'id': f"{row['id']}:turn_{index}", 'text': text[left:right],
                       'sentence': text[left:right], 'startMs': timestamps[first][0],
                       'endMs': timestamps[last][1], 'start': timestamps[first][0],
                       'end': timestamps[last][1], 'timestamp': timestamps[first:last + 1],
                       'spk': speaker, 'speakerId': f'speaker_{speaker}' if speaker is not None else f"unverified_{row['id']}_{index}",
                       'speakerVerified': speaker is not None, 'speakerMixed': speaker is None})
    return result


def attach_voiceprints(model: Any, wav_path: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if getattr(model, 'spk_model', None) is None or not rows:
        return [{**row, 'speakerVerified': False} for row in rows]
    import numpy as np
    import torch
    from funasr.models.campplus.utils import sv_chunk, correct_labels

    with wave.open(str(wav_path), 'rb') as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            return [{**row, 'speakerVerified': False} for row in rows]
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
    intervals: list[list[int]] = []
    for row in sorted(rows, key=lambda item: item['startMs']):
        if row.get('speakerMixed'):
            continue
        left, right = max(0, int(row['startMs'])), min(len(samples) // 16, int(row['endMs']))
        if right <= left:
            continue
        if intervals and left <= intervals[-1][1]:
            intervals[-1][1] = max(right, intervals[-1][1])
        else:
            intervals.append([left, right])
    windows = sv_chunk([[left / 1000, right / 1000, samples[left * 16:right * 16]] for left, right in intervals])
    if not windows:
        return [{**row, 'speakerVerified': False} for row in rows]
    outputs = model.inference([window[2] for window in windows], input_len=None,
                              model=model.spk_model, kwargs=model.spk_kwargs)
    embeddings = torch.cat([output['spk_embedding'] for output in outputs], dim=0)
    labels = correct_labels(model.cb_model(embeddings.cpu(), oracle_num=None))
    matrix = embeddings.detach().cpu().numpy()
    turns = acoustic_turns(windows, labels)
    centers = {}
    for label in set(int(item) for item in labels):
        # Short samples are insufficient to establish a cross-chunk identity.
        indices = [index for index, value in enumerate(labels) if int(value) == label and windows[index][1] - windows[index][0] >= 1]
        if not indices:
            continue
        center = matrix[indices].mean(axis=0)
        norm = float(np.linalg.norm(center))
        if math.isfinite(norm) and norm > 0 and np.isfinite(center).all():
            centers[f'speaker_{label}'] = (center / norm).tolist()
    result = []
    for row in rows:
        for segment in split_sentence(row, turns):
            vector = centers.get(segment['speakerId'])
            if segment.get('speakerVerified') and vector is not None:
                segment['speakerEmbedding'] = vector
            result.append(segment)
    return result
