import { mat4LookAt, mat4Multiply, mat4Perspective, type Mat4, type Vec3 } from "./math";

export class OrbitCamera {
  private target: Vec3 = [0, 0, 0];
  private distance = 3.0;
  private yaw = Math.PI * 0.25;
  private pitch = Math.PI * 0.15;
  private aspect = 16 / 9;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  setAspect(aspect: number) {
    this.aspect = aspect || 1;
  }

  setTarget(target: Vec3) {
    this.target = [...target];
  }

  setDistance(distance: number) {
    this.distance = Math.max(0.1, distance);
  }

  onPointerDown(clientX: number, clientY: number) {
    this.dragging = true;
    this.lastX = clientX;
    this.lastY = clientY;
  }

  onPointerMove(clientX: number, clientY: number) {
    if (!this.dragging) {
      return;
    }
    const dx = clientX - this.lastX;
    const dy = clientY - this.lastY;
    this.lastX = clientX;
    this.lastY = clientY;

    this.yaw -= dx * 0.005;
    this.pitch -= dy * 0.005;
    const limit = Math.PI * 0.45;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  onPointerUp() {
    this.dragging = false;
  }

  onWheel(deltaY: number) {
    const zoom = Math.exp(deltaY * 0.001);
    this.distance = Math.max(0.6, Math.min(12, this.distance * zoom));
  }

  getViewProjection(): Mat4 {
    const eye = this.getEyePosition();
    const view = mat4LookAt(eye, this.target, [0, 1, 0]);
    const proj = mat4Perspective(Math.PI / 3, this.aspect, 0.01, 100);
    return mat4Multiply(proj, view);
  }

  getEyePosition(): Vec3 {
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);

    return [
      this.target[0] + this.distance * cosPitch * cosYaw,
      this.target[1] + this.distance * sinPitch,
      this.target[2] + this.distance * cosPitch * sinYaw
    ];
  }
}
