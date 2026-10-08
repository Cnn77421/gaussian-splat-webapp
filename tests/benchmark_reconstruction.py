#!/usr/bin/env python3
"""Compare COLMAP matching on the same sampled video frames, outside job data."""
import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / 'ooosplat-test/run-ooo.sh'


def run(args, log):
    start = time.monotonic()
    with log.open('w') as f:
        subprocess.run([str(LAUNCHER), *map(str, args)], stdout=f, stderr=subprocess.STDOUT, check=True)
    return round(time.monotonic() - start, 2)


def benchmark(video, output, count=64):
    output.mkdir(parents=True, exist_ok=False)
    images = output / 'images'
    images.mkdir()
    metadata = json.loads(subprocess.check_output([str(LAUNCHER), 'probe', str(video)]))
    duration = metadata['duration']
    run(['ffmpeg', '-v', 'error', '-i', video, '-vf',
         f'fps={count/duration},scale=1000:1000:force_original_aspect_ratio=decrease',
         '-frames:v', count, images / 'frame_%06d.jpg'], output / 'extract.log')
    database = output / 'features.db'
    feature_seconds = run(['colmap', 'feature_extractor', '--database_path', database,
        '--image_path', images, '--ImageReader.single_camera', 1,
        '--ImageReader.camera_model', 'SIMPLE_RADIAL', '--SiftExtraction.use_gpu', 0,
        '--SiftExtraction.num_threads', 8, '--SiftExtraction.max_num_features', 8192],
        output / 'features.log')
    report = {'video': str(video), 'frames': len(list(images.glob('*.jpg'))),
              'featureSeconds': feature_seconds, 'variants': {}}
    for name, flags in [('baseline', []), ('guided-overlap20',
            ['--SiftMatching.guided_matching', 1, '--SequentialMatching.overlap', 20])]:
        db = output / f'{name}.db'
        shutil.copyfile(database, db)
        match_seconds = run(['colmap', 'sequential_matcher', '--database_path', db,
            '--SiftMatching.use_gpu', 0, '--SiftMatching.num_threads', 8, *flags],
            output / f'{name}-matching.log')
        sparse = output / name
        sparse.mkdir()
        mapper_seconds = run(['colmap', 'mapper', '--database_path', db,
            '--image_path', images, '--output_path', sparse,
            '--Mapper.num_threads', 8, '--Mapper.tri_ignore_two_view_tracks', 0],
            output / f'{name}-mapper.log')
        models = []
        for model in sorted(sparse.iterdir()):
            with (model / 'images.bin').open('rb') as f:
                registered = struct.unpack('<Q', f.read(8))[0]
            with (model / 'points3D.bin').open('rb') as f:
                points = struct.unpack('<Q', f.read(8))[0]
            models.append({'model': model.name, 'registered': registered, 'points3d': points})
        best = max(models, key=lambda m: (m['registered'], m['points3d']), default={})
        report['variants'][name] = {'matchSeconds': match_seconds, 'mapperSeconds': mapper_seconds,
            'models': models, 'best': best, 'ratio': best.get('registered', 0) / report['frames']}
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(name, json.dumps(report['variants'][name]), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('video', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--count', type=int, default=64)
    args = parser.parse_args()
    print(json.dumps(benchmark(args.video.resolve(), args.output.resolve(), args.count), indent=2))
