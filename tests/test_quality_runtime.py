"""Regression tests for actual quality, VRAM fallbacks, and CLI compatibility."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('quality_runtime', ROOT / 'ooosplat-test/quality-runtime.py')
quality = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(quality)
HIGH = ['--total-steps', '30000', '--max-resolution', '3200', '--max-splats', '200000',
        '--growth-stop-iter', '23000', '--export-every', '30000']
GPU = {'status': 'detected', 'name': 'RTX 5060 Laptop', 'totalMiB': 8151, 'freeMiB': 5700}


class QualityRuntimeTests(unittest.TestCase):
    def test_high_restores_schedule_and_resolution(self):
        args, high, emergency = quality.brush_args(HIGH, {}, GPU)
        self.assertEqual(quality.get_arg(args, '--total-steps'), '30000')
        self.assertEqual(quality.get_arg(args, '--max-resolution'), '3200')
        self.assertEqual(quality.get_arg(args, '--max-splats'), '600000')
        self.assertTrue(high)
        self.assertFalse(emergency)

    def test_unknown_or_busy_memory_retains_safe_cap(self):
        for gpu in ({'status': 'unavailable'}, {'status': 'ambiguous'},
                    {**GPU, 'freeMiB': 3000}, {**GPU, 'totalMiB': 6000}):
            args, _, _ = quality.brush_args(HIGH, {}, gpu)
            self.assertEqual(args, HIGH)

    def test_native_oom_retry_is_not_upgraded(self):
        args = quality.set_arg(HIGH, '--max-resolution', 2000)
        args = quality.set_arg(args, '--growth-stop-iter', 20000)
        result, _, emergency = quality.brush_args(args,
            {'SPLAT_HIGH_RES': '3840', 'SPLAT_HIGH_MAX_SPLATS': '1500000'}, GPU)
        self.assertTrue(emergency)
        self.assertEqual(result, args)

    def test_explicit_overrides_and_growth_schedule(self):
        args, _, _ = quality.brush_args(HIGH,
            {'SPLAT_HIGH_STEPS': '12000', 'SPLAT_HIGH_RES': '1440',
             'SPLAT_HIGH_MAX_SPLATS': '400000'}, GPU)
        self.assertEqual(quality.get_arg(args, '--total-steps'), '12000')
        self.assertEqual(quality.get_arg(args, '--export-every'), '12000')
        self.assertEqual(quality.get_arg(args, '--growth-stop-iter'), '9200')
        self.assertEqual(quality.get_arg(args, '--max-resolution'), '1440')
        self.assertEqual(quality.get_arg(args, '--max-splats'), '400000')
        with self.assertRaises(ValueError):
            quality.brush_args(HIGH, {'SPLAT_HIGH_STEPS': '-1'}, GPU)

    def test_fast_balanced_and_custom_cap_pass_through(self):
        for args in (['--total-steps', '8000', '--max-resolution', '1600'],
                     ['--total-steps', '15000', '--max-resolution', '1920'],
                     quality.set_arg(HIGH, '--max-splats', 1500000)):
            self.assertEqual(quality.brush_args(args, {}, GPU)[0], args)

    def test_guided_matching_only_for_high_and_respects_cli_options(self):
        args = ['sequential_matcher', '--database_path', '/tmp/space path/db']
        for preset in ('fast', 'balanced'):
            self.assertEqual(quality.colmap_args(args, {'SPLAT_JOB_QUALITY': preset}), args)
        high = quality.colmap_args(args, {'SPLAT_JOB_QUALITY': 'high'})
        self.assertEqual(quality.get_arg(high, '--SiftMatching.guided_matching'), '1')
        self.assertEqual(quality.get_arg(high, '--SequentialMatching.overlap'), '20')
        explicit = args + ['--SequentialMatching.overlap=12', '--SiftMatching.guided_matching', '0']
        result = quality.colmap_args(explicit, {'SPLAT_JOB_QUALITY': 'high'})
        self.assertEqual(quality.get_arg(result, '--SequentialMatching.overlap'), '12')
        self.assertEqual(quality.get_arg(result, '--SiftMatching.guided_matching'), '0')

    def test_gpu_parser_handles_single_gpu_failure_and_ambiguity(self):
        for output, expected in [('RTX 5060, 8151, 5700\n', 'detected'),
                                 ('GPU1, 8192, 5000\nGPU2, 8192, 5000\n', 'ambiguous'),
                                 ('GPU, N/A, N/A\n', 'unavailable')]:
            with mock.patch.object(quality.subprocess, 'run',
                    return_value=mock.Mock(returncode=0, stdout=output)):
                self.assertEqual(quality.detect_gpu()['status'], expected)
        with mock.patch.object(quality.subprocess, 'run', side_effect=subprocess.TimeoutExpired('nvidia-smi', 5)):
            self.assertEqual(quality.detect_gpu()['status'], 'unavailable')

    def test_modern_cli_gpu_override_and_explicit_quality(self):
        original = ['sequential_matcher', '--database_path', '/tmp/space path/db',
                    '--SiftMatching.use_gpu=0', '--SiftMatching.guided_matching', '0',
                    '--SequentialMatching.overlap', '12']
        result = quality.colmap_args(original,
            {'SPLAT_JOB_QUALITY': 'high', 'SPLAT_COLMAP_GPU': '1'}, modern=True)
        self.assertEqual(quality.get_arg(result, '--FeatureMatching.use_gpu'), '1')
        self.assertEqual(quality.get_arg(result, '--FeatureMatching.num_threads'), str(min(8, os.cpu_count() or 1)))
        self.assertEqual(quality.get_arg(result, '--FeatureMatching.gpu_index'), '0')
        self.assertEqual(quality.get_arg(result, '--FeatureMatching.guided_matching'), '0')
        self.assertEqual(quality.get_arg(result, '--SequentialMatching.overlap'), '12')
        self.assertEqual(quality.get_arg(result, '--database_path'), '/tmp/space path/db')
        self.assertFalse(any(arg.startswith('--SiftMatching.') for arg in result))
        cpu = quality.colmap_args(result, {'SPLAT_COLMAP_GPU': '0'}, modern=True)
        self.assertEqual(quality.get_arg(cpu, '--FeatureMatching.use_gpu'), '0')
        with self.assertRaises(ValueError):
            quality.colmap_args(original, {'SPLAT_COLMAP_GPU': 'yes'}, modern=True)

    def test_modern_extraction_keeps_sift_specific_flags_and_other_stages(self):
        original = ['feature_extractor', '--SiftExtraction.max_image_size', '1000',
                    '--SiftExtraction.max_num_features', '8192', '--SiftExtraction.use_gpu', '0']
        result = quality.colmap_args(original, {'SPLAT_COLMAP_GPU': '1'}, modern=True)
        self.assertEqual(quality.get_arg(result, '--FeatureExtraction.max_image_size'), '1000')
        self.assertEqual(quality.get_arg(result, '--SiftExtraction.max_num_features'), '8192')
        self.assertEqual(quality.get_arg(result, '--FeatureExtraction.use_gpu'), '1')
        mapper = ['mapper', '--database_path', '/tmp/db']
        self.assertEqual(quality.colmap_args(mapper, {'SPLAT_COLMAP_GPU': '1'}, modern=True), mapper)

    def test_external_engine_does_not_inherit_old_colmap_libraries(self):
        old = str(quality.BASE / 'root/usr/lib/x86_64-linux-gnu')
        with mock.patch.dict(os.environ, {'LD_LIBRARY_PATH': old + ':/custom/runtime'}):
            self.assertEqual(quality.colmap_environment('/tmp/new-colmap')['LD_LIBRARY_PATH'], '/custom/runtime')
            self.assertEqual(quality.colmap_environment(quality.BASE / 'root/usr/bin/colmap')['LD_LIBRARY_PATH'],
                             old + ':/custom/runtime')

    def test_gpu_report_requires_observed_gpu_initialization(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            real = root / 'fake-colmap'
            real.write_text('#!/usr/bin/env python3\nprint("Creating SIFT GPU feature matcher")\n')
            real.chmod(0o755)
            database = root / 'work/colmap/database.db'
            args = ['sequential_matcher', '--database_path', str(database), '--FeatureMatching.use_gpu', '1']
            self.assertEqual(quality.run_colmap(str(real), args, dict(os.environ)), 0)
            path = root / 'logs/quality-colmap.json'
            report = json.loads(path.read_text())
            self.assertTrue(report['commands'][0]['gpuConfirmed'])
            real.write_text('#!/usr/bin/env python3\nprint("ordinary output")\n')
            quality.run_colmap(str(real), args, dict(os.environ))
            report = json.loads(path.read_text())
            self.assertFalse(report['commands'][1]['gpuConfirmed'])

    def test_small_image_fix_breaks_hardlink_and_leaves_source_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            brush = root / 'work/brush'
            images = brush / 'dataset/images'
            images.mkdir(parents=True)
            source = root / 'source.jpg'
            data = b'\xff\xd8' + b'x' * 100 + b'\xff\xd9'
            source.write_bytes(data)
            os.link(source, images / 'copy.jpg')
            (images / 'broken.jpg').write_bytes(b'broken')
            self.assertEqual(quality.prepare_small_images(brush), 1)
            self.assertEqual(source.read_bytes(), data)
            self.assertEqual((images / 'copy.jpg').stat().st_size, 16387)
            self.assertEqual((images / 'broken.jpg').read_bytes(), b'broken')
            self.assertEqual(quality.prepare_small_images(root), 0)
            self.assertEqual(quality.prepare_small_images(brush), 0)

    def test_actual_wrapper_preserves_paths_and_emergency_report(self):
        with tempfile.TemporaryDirectory(prefix='quality space ') as temp:
            root = Path(temp)
            real = root / 'fake-brush'
            real.write_text('#!/usr/bin/env python3\nimport sys,json\nprint(json.dumps(sys.argv[1:]))\n')
            real.chmod(0o755)
            args = quality.set_arg(HIGH, '--max-resolution', 2000)
            args = quality.set_arg(args, '--growth-stop-iter', 20000)
            args += ['--export-path', str(root / 'work/brush'), str(root / 'dataset path')]
            env = {**os.environ, 'SPLAT_BRUSH_REAL': str(real)}
            for key in ('SPLAT_HIGH_STEPS', 'SPLAT_HIGH_RES', 'SPLAT_HIGH_STOP', 'SPLAT_HIGH_MAX_SPLATS'):
                env.pop(key, None)
            result = subprocess.run([str(ROOT / 'ooosplat-test/brush-tune.sh'), *args],
                                    env=env, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1]), args)
            report = json.loads((root / 'logs/quality-training.json').read_text())
            self.assertTrue(report['emergencyRetry'])
            self.assertEqual(report['effective']['total-steps'], '30000')

    def test_undistortion_updates_pixels_and_camera_together_and_reuses_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            brush = Path(temp) / 'work/brush'
            source = brush / 'dataset'
            model = source / 'sparse/0'
            model.mkdir(parents=True)
            for name in ('cameras', 'images', 'points3D'):
                (model / (name + '.bin')).write_bytes(name.encode())
            args = HIGH + ['--export-path', str(brush), str(source)]
            def convert(command, **kwargs):
                self.assertIn('image_undistorter', command)
                self.assertEqual(quality.get_arg(command, '--image_path'), str(source / 'images'))
                self.assertEqual(quality.get_arg(command, '--input_path'), str(model))
                output = brush / 'dataset-undistorted/sparse'
                output.mkdir(parents=True)
                (output / 'cameras.bin').write_bytes(b'corrected-camera')
            with mock.patch.object(quality.subprocess, 'run', side_effect=convert) as run:
                result, images = quality.undistort_dataset(args)
                self.assertEqual(result[-1], str(brush / 'dataset-undistorted'))
                self.assertEqual(images, brush / 'dataset-undistorted/images')
                quality.undistort_dataset(args)
                self.assertEqual(run.call_count, 1)
            self.assertEqual((model / 'cameras.bin').read_bytes(), b'cameras')

    def test_arbitrary_datasets_are_not_rewritten(self):
        args = HIGH + ['--export-path', '/tmp/output', '/tmp/original-photos']
        self.assertEqual(quality.undistort_dataset(args), (args, None))

    def test_transparent_images_keep_alpha_in_original_training_path(self):
        with tempfile.TemporaryDirectory() as temp:
            brush = Path(temp) / 'work/brush'
            source = brush / 'dataset'
            (source / 'images').mkdir(parents=True)
            header = bytearray(b'\x89PNG\r\n\x1a\n' + b'\0' * 25)
            header[25] = 6
            (source / 'images/alpha.png').write_bytes(header)
            args = HIGH + ['--export-path', str(brush), str(source)]
            with mock.patch.object(quality.subprocess, 'run') as run:
                self.assertEqual(quality.undistort_dataset(args), (args, None))
                run.assert_not_called()

    def test_backend_keeps_effective_report_before_pruning(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'server.py'
            shutil.copyfile(ROOT / 'splat-app/server.py', source)
            spec = importlib.util.spec_from_file_location('quality_server', source)
            server = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(server)
            project = server.PROJECTS_DIR / 'test'
            (project / 'logs').mkdir(parents=True)
            value = {'effective': {'total-steps': '30000'}}
            (project / 'logs/quality-training.json').write_text(json.dumps(value))
            (project / 'logs/quality-colmap.json').write_text(json.dumps({'commands': [{'gpuConfirmed': True}]}))
            job = {'id': 'test', 'projectPath': str(project)}
            server._attach_quality_report(job)
            self.assertEqual(job['qualityReport']['training'], value)
            self.assertTrue(job['qualityReport']['colmap']['commands'][0]['gpuConfirmed'])
            server._prune_project(job)
            self.assertTrue((project / 'logs/quality-training.json').exists())


if __name__ == '__main__':
    unittest.main()
