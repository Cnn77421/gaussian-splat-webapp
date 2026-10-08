"""Source camera metadata survives pruning; all projects live under /tmp."""
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / 'server.py'

class SourceViewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='splat-source-view-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        patch = mock.patch.dict(os.environ, {'SPLAT_DATA_DIR': str(root / 'data')})
        patch.start(); self.addCleanup(patch.stop)
        isolated = root / 'server.py'; shutil.copyfile(SOURCE, isolated)
        spec = importlib.util.spec_from_file_location('isolated_source_view', isolated)
        self.server = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.server)
        self.job = self.server.new_job('sample.mp4', 'fast'); self.job['status'] = 'done'
        self.project = self.server.PROJECTS_DIR / 'fixture'; self.project.mkdir()
        self.job['projectPath'] = str(self.project)

    def model(self, relative='work/brush/dataset/sparse/0', q=(1,0,0,0), t=(1,2,3)):
        model = self.project / relative; model.mkdir(parents=True, exist_ok=True)
        (model / 'cameras.bin').write_bytes(struct.pack('<QiiQQ4d', 1, 1, 1, 640, 480, 400, 420, 320, 240))
        data = struct.pack('<Q', 2)
        # Binary registration order is different from shooting order.
        for iid, name in [(1,b'frame_0002.jpg'),(2,b'frame_0001.jpg')]:
            data += struct.pack('<i7di', iid, *q, *t, 1) + name + b'\0' + struct.pack('<Q',1) + struct.pack('<ddq', 12,34,-1)
        (model / 'images.bin').write_bytes(data)
        return model

    def test_camera_math_fov_and_capture_order(self):
        pose = self.server._source_camera(self.model())
        self.assertEqual(pose['position'], [-1,-2,-3])
        self.assertEqual(pose['forward'], [0,0,1]); self.assertEqual(pose['up'], [0,-1,0])
        self.assertEqual(pose['image'], 'frame_0001.jpg')
        self.assertAlmostEqual(pose['fov'], math.degrees(2*math.atan(480/840)))
        pose = self.server._source_camera(self.model(q=(math.sqrt(.5),0,math.sqrt(.5),0)))
        self.assertAlmostEqual(pose['forward'][0], -1)
        self.assertAlmostEqual(pose['position'][0], 3)
        self.assertAlmostEqual(pose['position'][2], -1)

    def test_pruning_keeps_training_pose_sidecar_and_job_field(self):
        self.model(t=(20,0,0))
        self.model('work/brush/dataset-undistorted/sparse', t=(2,0,0))
        (self.project/'logs').mkdir()
        (self.project/'logs/quality-training.json').write_text('{"lensDistortionCorrected": true}')
        self.server.KEEP_WORK = False
        self.server._prune_project(self.job)
        self.assertFalse((self.project/'work').exists())
        self.assertEqual(self.job['sourceView']['position'], [-2,0,0])
        self.assertEqual(json.loads((self.project/'source-view.json').read_text()), self.job['sourceView'])
        self.server._save_jobs(); self.server._jobs.clear(); self.server._load_jobs()
        self.assertEqual(self.server.get_job(self.job['id'])['sourceView']['position'], [-2,0,0])
        del self.job['sourceView']
        self.assertTrue(self.server._attach_source_view(self.job))

    def test_startup_saves_camera_before_cleaning_old_work(self):
        self.model(); self.server.KEEP_WORK = False
        self.assertEqual(self.server._reconcile_work(), 1)
        self.assertTrue((self.project/'source-view.json').is_file())
        self.assertIn('sourceView', json.loads(self.server.JOBS_FILE.read_text())[0])

    def test_missing_or_corrupt_camera_data_does_not_block_cleanup(self):
        self.assertFalse(self.server._attach_source_view(self.job))
        model = self.model(); (model/'images.bin').write_bytes(b'bad')
        self.server.KEEP_WORK = False; self.server._prune_project(self.job)
        self.assertNotIn('sourceView', self.job)
        self.assertFalse((self.project/'work').exists())

    def test_stale_undistorted_cache_is_not_used(self):
        self.model(t=(3,0,0))
        self.model('work/brush/dataset-undistorted/sparse', t=(30,0,0))
        self.assertTrue(self.server._attach_source_view(self.job))
        self.assertEqual(self.job['sourceView']['position'], [-3,0,0])

    def test_external_project_is_not_read_or_written(self):
        self.job['projectPath'] = str(Path(self.temp.name))
        self.assertFalse(self.server._attach_source_view(self.job))

if __name__ == '__main__': unittest.main()
