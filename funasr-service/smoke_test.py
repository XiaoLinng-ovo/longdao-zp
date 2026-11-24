"""Exercise local offline ASR and the browser's streaming proxy with synthetic speech."""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

import websockets


TEXT = "\u4f60\u597d\uff0c\u6211\u8d1f\u8d23\u62db\u8058\u7cfb\u7edf\u7684\u5f00\u53d1\u548c\u6d4b\u8bd5\u3002\u8fd9\u4e2a\u9879\u76ee\u4f7f\u7528\u6570\u636e\u5e93\u4fdd\u5b58\u5019\u9009\u4eba\u4fe1\u606f\u3002"
KEYWORDS = ("\u62db\u8058", "\u7cfb\u7edf", "\u6570\u636e\u5e93")


def check_text(text: str) -> None:
    missing = [word for word in KEYWORDS if word not in text]
    if missing:
        raise AssertionError(f"Recognition missed synthetic speech keywords {missing}: {text}")


def synthesize(directory: Path) -> Path:
    source = directory / 'synthetic-source.wav'
    output = directory / 'synthetic-16k.wav'
    encoded = base64.b64encode(TEXT.encode('utf-8')).decode('ascii')
    escaped = str(source).replace("'", "''")
    command = (
        "Add-Type -AssemblyName System.Speech; "
        "$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try { $speech.SelectVoice('Microsoft Huihui Desktop'); "
        f"$speech.SetOutputToWaveFile('{escaped}'); "
        f"$speech.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))) "
        "} finally { $speech.Dispose() }"
    )
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                   check=True, timeout=40, creationflags=subprocess.CREATE_NO_WINDOW)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                    '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', str(output)],
                   check=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    return output


def offline(base_url: str, path: Path) -> dict:
    started = time.monotonic()
    request = urllib.request.Request(base_url + '/transcribe', data=path.read_bytes(),
                                     headers={'Content-Type': 'audio/wav'}, method='POST')
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
    check_text(payload['text'])
    if not payload.get('segments'):
        raise AssertionError('Offline ASR returned no segments')
    return {'text': payload['text'], 'segments': len(payload['segments']),
            'speakerVerified': any(row.get('speakerVerified') for row in payload['segments']),
            'elapsedSeconds': round(time.monotonic() - started, 2)}


async def streaming(url: str, path: Path) -> dict:
    with wave.open(str(path), 'rb') as audio:
        assert audio.getframerate() == 16000 and audio.getnchannels() == 1
        pcm = audio.readframes(audio.getnframes())
    started = time.monotonic()
    finals = []
    async with websockets.connect(url, open_timeout=15, close_timeout=5) as socket:
        while True:
            message = json.loads(await asyncio.wait_for(socket.recv(), timeout=30))
            if message.get('type') == 'error':
                raise AssertionError(message)
            if message.get('status') == 'ready':
                break
        for identity in ('synthetic-1', 'synthetic-2'):
            for offset in range(0, len(pcm), 19200):
                await socket.send(pcm[offset:offset + 19200])
            await socket.send(json.dumps({'type': 'commit', 'commitId': identity}))
            async with asyncio.timeout(120):
                while True:
                    message = json.loads(await socket.recv())
                    if message.get('type') == 'error':
                        raise AssertionError(message)
                    if message.get('type') == 'final':
                        assert message.get('commitId') == identity, message
                        check_text(message['text'])
                        finals.append(message['text'])
                        break
        if len(finals[1]) > len(finals[0]) * 1.5:
            raise AssertionError('Streaming commit retained the previous utterance')
        await socket.send(json.dumps({'type': 'end'}))
        end = json.loads(await asyncio.wait_for(socket.recv(), timeout=30))
        assert end.get('type') == 'final' and not end.get('text'), end
    return {'utterances': finals, 'elapsedSeconds': round(time.monotonic() - started, 2)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:10095')
    parser.add_argument('--stream-url', default='ws://127.0.0.1:5174/funasr-stream')
    options = parser.parse_args()
    with urllib.request.urlopen(options.base_url + '/ready', timeout=10) as response:
        health = json.load(response)
    assert health['ready'] and health['speakerModelLoaded'], health
    with tempfile.TemporaryDirectory(prefix='funasr-synthetic-smoke-') as temporary:
        path = synthesize(Path(temporary))
        result = {'offline': offline(options.base_url, path),
                  'streamingProxy': asyncio.run(streaming(options.stream_url, path))}
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
