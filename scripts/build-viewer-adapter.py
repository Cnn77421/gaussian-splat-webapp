from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = (root / 'web/vendor/supersplat/index.js').read_text()
needle = '        annotations: global.settings.annotations,\n'
assert source.count(needle) == 1
source = source.replace(needle, needle + '''        // Host camera handoff: expose the existing upstream snapshot helpers.
        getCameraState: () => captureCameraState(viewer.cameraManager, state),
        setCameraState: (snapshot) => restoreCameraState(viewer.cameraManager, state, snapshot),
''')
# Fly upstream discards roll and fixes FOV to 90 on every update. Preserve the
# entered pose instead, so the host's horizon and framing survive a mode switch.
start = source.index('class FlyController {')
end = source.index('const RAD_TO_DEG', start)
fly = source[start:end]
needle = '    _targetAngles = new Vec3();'
assert fly.count(needle) == 1
fly = fly.replace(needle, needle + '''
    // Mouse yaw/pitch are relative to the entered camera frame, which can be
    // tilted for this model. World Euler yaw would then turn into screen roll.
    _lookFrame = new Quat();
    _lookFrameInverse = new Quat();
    _lookRotation = new Quat();
    _lookAngles = new Vec3();''')
assert fly.count('camera.angles.set(this._angles.x, this._angles.y, 0);') == 1
fly = fly.replace('camera.angles.set(this._angles.x, this._angles.y, 0);', 'camera.angles.copy(this._angles);')
fly = fly.replace('this._angles.set(camera.angles.x, camera.angles.y, 0);', 'this._angles.copy(camera.angles);\n        this.fov = camera.fov;')
needle = '''        applyFrameRotation(this._targetAngles, rotate);
        dampAngles(this._angles, this._targetAngles, this.rotateDamping, deltaTime);'''
assert fly.count(needle) == 1
fly = fly.replace(needle, '''        applyFrameRotation(this._targetAngles, rotate, -89, 89);
        dampAngles(this._lookAngles, this._targetAngles, this.rotateDamping, deltaTime);
        this._lookRotation.setFromEulerAngles(this._lookAngles);
        this._lookRotation.mul2(this._lookFrame, this._lookRotation);
        this._lookRotation.getEulerAngles(this._angles);''')
# Both goto and reset-to-spawn must reset the input frame as well as the pose.
needle = '        this._targetAngles.copy(this._angles);'
assert fly.count(needle) == 2
fly = fly.replace(needle, '''        this._lookFrame.setFromEulerAngles(this._angles);
        this._lookFrameInverse.invert(this._lookFrame);
        this._lookAngles.set(0, 0, 0);
        this._targetAngles.set(0, 0, 0);''')
source = source[:start] + fly + source[end:]
# Automatic fly-to input must use the same reference frame as mouse input.
# Keep destinations and collision/movement in world space.
start = source.index('class FlySource {')
end = source.index('const p = new Pose();', start)
fly_source = source[start:end]
assert fly_source.count('    flySpeed = 4;') == 1
fly_source = fly_source.replace('    flySpeed = 4;', '''    flySpeed = 4;
    controller = null;
    _frameToTarget = new Vec3();''')
needle = '        const cameraAngles = camera.angles;'
assert fly_source.count(needle) == 1
fly_source = fly_source.replace(needle, '        const cameraAngles = this.controller?._lookAngles ?? camera.angles;')
needle = '        const yawDiff = getYawDiffToTarget(toTarget.x, toTarget.z, cameraAngles.y);\n        const pitchDiff = getPitchToDirection(dirY) - cameraAngles.x;'
assert fly_source.count(needle) == 1
fly_source = fly_source.replace(needle, '''        const localTarget = this.controller
            ? this.controller._lookFrameInverse.transformVector(toTarget, this._frameToTarget)
            : toTarget;
        const yawDiff = getYawDiffToTarget(localTarget.x, localTarget.z, cameraAngles.y);
        const pitchDiff = getPitchToDirection(localTarget.y * invDist) - cameraAngles.x;''')
fly_source = fly_source.replace('// FlyController applies: _angles += [-rotateY, -rotateX, 0]',
    '// FlyController applies yaw/pitch deltas in the entered camera frame')
needle = '        setCameraForward(postTurnAngles, forward$1);'
assert fly_source.count(needle) == 1
fly_source = fly_source.replace(needle, needle + '''
        this.controller?._lookFrame.transformVector(forward$1, forward$1);''')
source = source[:start] + fly_source + source[end:]
needle = '        const flySource = new FlySource();'
assert source.count(needle) == 1
source = source.replace(needle, needle + '\n        flySource.controller = controllers.fly;')
start = source.index('class OrbitController {')
end = source.index('const FIXED_DT', start)
orbit = source[start:end]
needle = '    onEnter(camera) {\n        this._attach(camera);'
assert orbit.count(needle) == 1
orbit = orbit.replace(needle, '    onEnter(camera) {\n        this.fov = camera.fov;\n        this._attach(camera);')
source = source[:start] + orbit + source[end:]
# A native orbit/fly transition uses look-at interpolation, which removes
# roll even when source and destination poses are identical. Re-seed directly.
needle = '            newController.onEnter(this.camera);\n        });'
assert source.count(needle) == 1
source = source.replace(needle, '            newController.onEnter(this.camera);\n            if (["orbit", "fly"].includes(value) && ["orbit", "fly"].includes(prev)) this.snap();\n        });')
(root / 'web/vendor/supersplat/host-viewer.js').write_text(source)
