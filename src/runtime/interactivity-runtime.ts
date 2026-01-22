
export type ValueType = "bool" | "int" | "float" | "float2" | "float3" | "float4" | "float4x4";

type Value = {
  type: ValueType;
  data: number[] | boolean[];
};

type NodeRef = { node: number; socket: string };

type NodeValue =
  | { type: number; value: Array<number | boolean | string> }
  | NodeRef;

export type GraphNode = {
  declaration: number;
  configuration?: Record<string, { value: Array<number | boolean | string> }>;
  values?: Record<string, NodeValue>;
  flows?: Record<string, NodeRef>;
};

export type Graph = {
  types: Array<{ signature: ValueType }>;
  variables: Array<{ id: string; type: number; value: Array<number | boolean | string> }>;
  events: Array<{ id: string; values: Record<string, { type: number; value: Array<number | boolean | string> }> }>;
  declarations: Array<{ op: string }>;
  nodes: GraphNode[];
};

export type RuntimeGraph = {
  graph: Graph;
  variables: Value[];
  nodeStates: Map<number, NodeState>;
  nodeOutputs: Map<number, Map<string, Value>>;
  eventPayloads: Map<number, EventPayload>;
  time: number;
  pointerX: number;
  pointerY: number;
  delays: DelayItem[];
  interpolations: Interpolation[];
  gltf: any;
  eventReceivers: Map<number, number[]>;
  randomState: number;
  nextDelayId: number;
  trace?: number[];
  onPointerSet?: (pointer: string, value: number[] | boolean[] | number | boolean) => void;
  onDirty?: () => void;
};

type NodeState = {
  doNCount?: number;
  forIndex?: number;
  throttleTime?: number;
  throttleRemaining?: number;
  remainingInputs?: number;
  waitAllSeen?: Set<string>;
  waitAllActivated?: boolean[];
  multiGateLastIndex?: number;
  multiGateUsed?: boolean[];
  lastDelayIndex?: number;
  delayIds?: number[];
};

type DelayItem = {
  id: number;
  time: number;
  nodeId: number;
  socket: string;
  canceled: boolean;
  ownerNodeId: number;
};

type Interpolation = {
  variableIndex: number;
  startTime: number;
  duration: number;
  startValue: Value;
  endValue: Value;
  p1: [number, number];
  p2: [number, number];
  useSlerp: boolean;
  doneFlow?: NodeRef;
  errFlow?: NodeRef;
};

type EventPayload = {
  boolParameter?: boolean;
  intParameter?: number;
  floatParameter?: number;
  expectedDuration?: number;
};

export type ExecuteOptions = {
  maxIterations?: number;
  tickStep?: number;
};

function parseScalar(value: number | boolean | string): number | boolean | string {
  if (typeof value === "string") {
    if (value === "NaN") {
      return NaN;
    }
    if (value === "Infinity") {
      return Infinity;
    }
    if (value === "-Infinity") {
      return -Infinity;
    }
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return value;
  }
  return value;
}

function toValue(signature: ValueType, raw: Array<number | boolean | string>): Value {
  const parsed = raw.map((item) => parseScalar(item));
  if (signature === "bool") {
    return { type: signature, data: parsed.map((item) => Boolean(item)) };
  }
  return { type: signature, data: parsed.map((item) => Number(item)) };
}

function cloneValue(value: Value): Value {
  return { type: value.type, data: Array.isArray(value.data) ? [...value.data] : value.data } as Value;
}

function defaultValue(signature: ValueType): Value {
  switch (signature) {
    case "bool":
      return { type: signature, data: [false] };
    case "int":
    case "float":
      return { type: signature, data: [0] };
    case "float2":
      return { type: signature, data: [0, 0] };
    case "float3":
      return { type: signature, data: [0, 0, 0] };
    case "float4":
      return { type: signature, data: [0, 0, 0, 0] };
    case "float4x4":
      return {
        type: signature,
        data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      };
  }
}

function valueToNumberArray(value: Value): number[] {
  if (value.type === "bool") {
    return (value.data as boolean[]).map((item) => (item ? 1 : 0));
  }
  return value.data as number[];
}

function boolValue(data: boolean[]): Value {
  return { type: "bool", data };
}

function floatValue(data: number[]): Value {
  return { type: "float", data };
}

function intValue(data: number[]): Value {
  return { type: "int", data: data.map((item) => Math.trunc(item)) };
}

function broadcast(a: number[], b: number[]) {
  if (a.length === b.length) {
    return [a, b];
  }
  if (a.length === 1) {
    return [new Array(b.length).fill(a[0]), b];
  }
  if (b.length === 1) {
    return [a, new Array(a.length).fill(b[0])];
  }
  return [a, b];
}

function applyBinary(a: Value, b: Value, op: (x: number, y: number) => number, outputType?: ValueType): Value {
  const aNum = valueToNumberArray(a);
  const bNum = valueToNumberArray(b);
  const [left, right] = broadcast(aNum, bNum);
  const out = left.map((item, index) => op(item, right[index] ?? right[0] ?? 0));
  const type = outputType ?? a.type;
  if (type === "int") {
    return intValue(out);
  }
  if (type === "bool") {
    return boolValue(out.map((item) => Boolean(item)));
  }
  return floatValue(out);
}

function applyUnary(a: Value, op: (x: number) => number, outputType?: ValueType): Value {
  const aNum = valueToNumberArray(a);
  const out = aNum.map((item) => op(item));
  const type = outputType ?? a.type;
  if (type === "int") {
    return intValue(out);
  }
  if (type === "bool") {
    return boolValue(out.map((item) => Boolean(item)));
  }
  return floatValue(out);
}

function isFiniteValue(value: Value): boolean {
  return valueToNumberArray(value).every((item) => Number.isFinite(item));
}

function bezierY(t: number, p1: [number, number], p2: [number, number]): number {
  const u = 1 - t;
  return 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t;
}

function quatNormalize(q: number[]): number[] {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatMul(a: number[], b: number[]): number[] {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

function quatSlerp(a: number[], b: number[], t: number): number[] {
  let cosTheta = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  if (cosTheta < 0) {
    cosTheta = -cosTheta;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cosTheta > 0.9995) {
    return quatNormalize([
      a[0] + t * (bx - a[0]),
      a[1] + t * (by - a[1]),
      a[2] + t * (bz - a[2]),
      a[3] + t * (bw - a[3])
    ]);
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  const sinTheta = Math.sin(angle);
  const w1 = Math.sin((1 - t) * angle) / sinTheta;
  const w2 = Math.sin(t * angle) / sinTheta;
  return [
    a[0] * w1 + bx * w2,
    a[1] * w1 + by * w2,
    a[2] * w1 + bz * w2,
    a[3] * w1 + bw * w2
  ];
}
function mat4Identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mat4Mul(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      out[i + j * 4] =
        a[i] * b[j * 4] +
        a[i + 4] * b[j * 4 + 1] +
        a[i + 8] * b[j * 4 + 2] +
        a[i + 12] * b[j * 4 + 3];
    }
  }
  return out;
}

function mat4Transpose(m: number[]): number[] {
  return [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15]
  ];
}

function mat4Determinant(m: number[]): number {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

function mat4Invert(m: number[]): { value: number[]; isValid: boolean } {
  const out = new Array(16).fill(0);
  const a00 = m[0];
  const a01 = m[1];
  const a02 = m[2];
  const a03 = m[3];
  const a10 = m[4];
  const a11 = m[5];
  const a12 = m[6];
  const a13 = m[7];
  const a20 = m[8];
  const a21 = m[9];
  const a22 = m[10];
  const a23 = m[11];
  const a30 = m[12];
  const a31 = m[13];
  const a32 = m[14];
  const a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) {
    return { value: mat4Identity(), isValid: false };
  }
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;

  return { value: out, isValid: true };
}

function mat4Compose(translation: number[], rotation: number[], scale: number[]): number[] {
  const [tx, ty, tz] = translation;
  const [qx, qy, qz, qw] = rotation;
  const [sx, sy, sz] = scale;
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1
  ];
}

function mat4Decompose(mat: number[]): { translation: number[]; rotation: number[]; scale: number[]; isValid: boolean } {
  const invalidResult = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], isValid: false };
  if (!mat.every(Number.isFinite)) {
    return invalidResult;
  }
  const row4Valid = Math.abs(mat[3]) <= 1e-5 && Math.abs(mat[7]) <= 1e-5 && Math.abs(mat[11]) <= 1e-5 && Math.abs(mat[15] - 1) <= 1e-5;
  if (!row4Valid) {
    return invalidResult;
  }
  const sx = Math.hypot(mat[0], mat[1], mat[2]);
  const sy = Math.hypot(mat[4], mat[5], mat[6]);
  const sz = Math.hypot(mat[8], mat[9], mat[10]);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) || sx === 0 || sy === 0 || sz === 0) {
    return invalidResult;
  }
  let b00 = mat[0] / sx;
  let b10 = mat[1] / sx;
  let b20 = mat[2] / sx;
  let b01 = mat[4] / sy;
  let b11 = mat[5] / sy;
  let b21 = mat[6] / sy;
  let b02 = mat[8] / sz;
  let b12 = mat[9] / sz;
  let b22 = mat[10] / sz;
  const det = b00 * (b11 * b22 - b12 * b21) - b01 * (b10 * b22 - b12 * b20) + b02 * (b10 * b21 - b11 * b20);
  const detTolerance = 0.25;
  if (!Number.isFinite(det) || Math.abs(Math.abs(det) - 1) > detTolerance) {
    return invalidResult;
  }
  const translation = [mat[12], mat[13], mat[14]];
  let scale = [sx, sy, sz];
  if (det < 0) {
    scale = [-sx, sy, sz];
    b00 = -b00;
    b10 = -b10;
    b20 = -b20;
  }
  const trace = b00 + b11 + b22;
  let rotation: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    rotation = [(b21 - b12) / s, (b02 - b20) / s, (b10 - b01) / s, 0.25 * s];
  } else if (b00 > b11 && b00 > b22) {
    const s = Math.sqrt(1 + b00 - b11 - b22) * 2;
    rotation = [0.25 * s, (b01 + b10) / s, (b02 + b20) / s, (b21 - b12) / s];
  } else if (b11 > b22) {
    const s = Math.sqrt(1 + b11 - b00 - b22) * 2;
    rotation = [(b01 + b10) / s, 0.25 * s, (b12 + b21) / s, (b02 - b20) / s];
  } else {
    const s = Math.sqrt(1 + b22 - b00 - b11) * 2;
    rotation = [(b02 + b20) / s, (b12 + b21) / s, 0.25 * s, (b10 - b01) / s];
  }
  return { translation, rotation: quatNormalize(rotation), scale, isValid: true };
}

function transformVec3(mat: number[], vec: number[]): number[] {
  const x = vec[0];
  const y = vec[1];
  const z = vec[2];
  const w = vec.length > 3 ? vec[3] : 1;
  return [
    mat[0] * x + mat[4] * y + mat[8] * z + mat[12] * w,
    mat[1] * x + mat[5] * y + mat[9] * z + mat[13] * w,
    mat[2] * x + mat[6] * y + mat[10] * z + mat[14] * w,
    mat[3] * x + mat[7] * y + mat[11] * z + mat[15] * w
  ];
}

function quatFromAxisAngle(axis: number[], angle: number): number[] {
  const [x, y, z] = axis;
  const len = Math.hypot(x, y, z) || 1;
  const half = angle / 2;
  const s = Math.sin(half) / len;
  return quatNormalize([x * s, y * s, z * s, Math.cos(half)]);
}

function quatToAxisAngle(quat: number[]): { axis: number[]; angle: number } {
  const q = quatNormalize(quat);
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, q[3])));
  const s = Math.sqrt(1 - q[3] * q[3]);
  if (s < 0.0001) {
    return { axis: [1, 0, 0], angle };
  }
  return { axis: [q[0] / s, q[1] / s, q[2] / s], angle };
}

function quatFromDirections(a: number[], b: number[]): number[] {
  const v1 = normalizeVec3(a);
  const v2 = normalizeVec3(b);
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  if (dot < -0.999999) {
    const axis = Math.abs(v1[0]) > 0.1 ? [0, 1, 0] : [1, 0, 0];
    const cross = crossVec3(v1, axis);
    return quatFromAxisAngle(cross, Math.PI);
  }
  const cross = crossVec3(v1, v2);
  return quatNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}

function quatFromUpForward(up: number[], forward: number[]): number[] {
  const r = normalizeVec3(forward);
  const y = normalizeVec3(up);
  let s = crossVec3(y, r);
  const sLen = Math.hypot(s[0], s[1], s[2]);
  if (sLen < 1e-5) {
    const axis = Math.abs(r[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    s = crossVec3(axis, r);
  }
  s = normalizeVec3(s);
  const t = crossVec3(r, s);
  const m00 = s[0], m01 = t[0], m02 = r[0];
  const m10 = s[1], m11 = t[1], m12 = r[1];
  const m20 = s[2], m21 = t[2], m22 = r[2];
  const trace = m00 + m11 + m22;
  let q: number[];
  if (trace > 0) {
    const s2 = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s2, (m02 - m20) / s2, (m10 - m01) / s2, 0.25 * s2];
  } else if (m00 > m11 && m00 > m22) {
    const s2 = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s2, (m01 + m10) / s2, (m02 + m20) / s2, (m21 - m12) / s2];
  } else if (m11 > m22) {
    const s2 = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s2, 0.25 * s2, (m12 + m21) / s2, (m02 - m20) / s2];
  } else {
    const s2 = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s2, (m12 + m21) / s2, 0.25 * s2, (m10 - m01) / s2];
  }
  return quatNormalize(q);
}

function quatAngleBetween(a: number[], b: number[]): number {
  const qa = quatNormalize(a);
  const qb = quatNormalize(b);
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  return Math.acos(Math.min(1, Math.abs(dot))) * 2;
}

function normalizeVec3(a: number[]): number[] {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

function crossVec3(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function rotate2D(v: number[], angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

function rotate3D(v: number[], q: number[]): number[] {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx
  ];
}

function resolveGraph(gltf: any): Graph {
  const inter = gltf.extensions?.KHR_interactivity;
  if (!inter) {
    throw new Error("Missing KHR_interactivity.");
  }
  const graph = inter.graphs?.[0] as Graph;
  if (!graph) {
    throw new Error("Missing graph.");
  }
  return graph;
}

function prepareGltfData(gltf: any) {
  const cloned = JSON.parse(JSON.stringify(gltf));
  const nodes = cloned.nodes ?? [];
  const parents = new Array(nodes.length).fill(-1);
  nodes.forEach((node: any, index: number) => {
    (node.children ?? []).forEach((child: number) => {
      parents[child] = index;
    });
  });
  nodes.forEach((node: any, index: number) => {
    if (parents[index] >= 0) {
      node.parent = parents[index];
    }
  });
  return cloned;
}

function getConfigValue(node: GraphNode, key: string) {
  const entry = node.configuration?.[key];
  if (!entry) {
    return undefined;
  }
  const parsed = entry.value.map((item) => parseScalar(item));
  return parsed.length === 1 ? parsed[0] : parsed;
}

function getNodeValue(graph: Graph, node: GraphNode, key: string): Value | NodeRef | undefined {
  const entry = node.values?.[key];
  if (!entry) {
    return undefined;
  }
  if ("node" in entry) {
    return { node: entry.node, socket: entry.socket ?? "value" };
  }
  const signature = graph.types[entry.type]?.signature ?? "float";
  return toValue(signature, entry.value);
}

function getOutputCached(runtime: RuntimeGraph, nodeId: number, socket: string) {
  const map = runtime.nodeOutputs.get(nodeId);
  if (!map) {
    return undefined;
  }
  return map.get(socket);
}

function setOutput(runtime: RuntimeGraph, nodeId: number, socket: string, value: Value) {
  let map = runtime.nodeOutputs.get(nodeId);
  if (!map) {
    map = new Map();
    runtime.nodeOutputs.set(nodeId, map);
  }
  map.set(socket, value);
}

function toIndex(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return toIndex(value[0]);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function evaluateValue(runtime: RuntimeGraph, nodeId: number, socket: string, stack: Set<string>): Value {
  const key = `${nodeId}:${socket}`;
  if (stack.has(key)) {
    return defaultValue("float");
  }
  stack.add(key);
  const node = runtime.graph.nodes[nodeId];
  const op = runtime.graph.declarations[node.declaration]?.op ?? "";
  const cached = getOutputCached(runtime, nodeId, socket);
  if (cached) {
    if (op !== "event/onTick" && op !== "event/onPointerMove" && op !== "event/onPointerDown" && op !== "event/onPointerUp") {
      stack.delete(key);
      return cached;
    }
  }

  let result = defaultValue("float");
  switch (op) {
    case "math/add":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => x + y);
      break;
    case "math/sub":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => x - y);
      break;
    case "math/mul":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => x * y);
      break;
    case "math/div":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => x / y);
      break;
    case "math/rem":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => x % y);
      break;
    case "math/abs":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.abs(x));
      break;
    case "math/ceil":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.ceil(x));
      break;
    case "math/floor":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.floor(x));
      break;
    case "math/trunc":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.trunc(x));
      break;
    case "math/fract":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => x - Math.floor(x));
      break;
    case "math/sign":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.sign(x));
      break;
    case "math/sqrt":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.sqrt(x));
      break;
    case "math/exp":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.exp(x));
      break;
    case "math/neg":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => -x);
      break;
    case "math/log":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.log(x));
      break;
    case "math/log2":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.log2(x));
      break;
    case "math/log10":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.log10(x));
      break;
    case "math/pow":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => Math.pow(x, y));
      break;
    case "math/asin":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.asin(x));
      break;
    case "math/acos":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.acos(x));
      break;
    case "math/atan":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.atan(x));
      break;
    case "math/atan2":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => Math.atan2(x, y));
      break;
    case "math/sin":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.sin(x));
      break;
    case "math/cos":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.cos(x));
      break;
    case "math/tan":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.tan(x));
      break;
    case "math/sinh":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.sinh(x));
      break;
    case "math/cosh":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.cosh(x));
      break;
    case "math/tanh":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.tanh(x));
      break;
    case "math/asinh":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.asinh(x));
      break;
    case "math/acosh":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.acosh(x));
      break;
    case "math/atanh":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.atanh(x));
      break;
    case "math/cbrt":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.cbrt(x));
      break;
    case "math/deg":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => (x * 180) / Math.PI);
      break;
    case "math/rad":
      result = applyUnary(getInput(runtime, nodeId, "a", stack), (x) => (x * Math.PI) / 180);
      break;
    case "math/gt":
      result = boolValue([valueToNumberArray(getInput(runtime, nodeId, "a", stack))[0] > valueToNumberArray(getInput(runtime, nodeId, "b", stack))[0]]);
      break;
    case "math/ge":
      result = boolValue([valueToNumberArray(getInput(runtime, nodeId, "a", stack))[0] >= valueToNumberArray(getInput(runtime, nodeId, "b", stack))[0]]);
      break;
    case "math/lt":
      result = boolValue([valueToNumberArray(getInput(runtime, nodeId, "a", stack))[0] < valueToNumberArray(getInput(runtime, nodeId, "b", stack))[0]]);
      break;
    case "math/le":
      result = boolValue([valueToNumberArray(getInput(runtime, nodeId, "a", stack))[0] <= valueToNumberArray(getInput(runtime, nodeId, "b", stack))[0]]);
      break;
    case "math/eq": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      const [left, right] = broadcast(a, b);
      const matches = left.every((item, index) => item === (right[index] ?? right[0]));
      result = boolValue([matches]);
      break;
    }
    case "math/and": {
      const a = getInput(runtime, nodeId, "a", stack);
      const b = getInput(runtime, nodeId, "b", stack);
      if (a.type === "bool" || b.type === "bool") {
        const left = valueToNumberArray(a).map((item) => Boolean(item));
        const right = valueToNumberArray(b).map((item) => Boolean(item));
        const [l, r] = broadcast(left.map((item) => (item ? 1 : 0)), right.map((item) => (item ? 1 : 0)));
        result = boolValue(l.map((item, index) => Boolean(item) && Boolean(r[index] ?? r[0])));
      } else {
        result = intValue(applyBinary(a, b, (x, y) => (x | 0) & (y | 0), "int").data as number[]);
      }
      break;
    }
    case "math/or": {
      const a = getInput(runtime, nodeId, "a", stack);
      const b = getInput(runtime, nodeId, "b", stack);
      if (a.type === "bool" || b.type === "bool") {
        const left = valueToNumberArray(a).map((item) => Boolean(item));
        const right = valueToNumberArray(b).map((item) => Boolean(item));
        const [l, r] = broadcast(left.map((item) => (item ? 1 : 0)), right.map((item) => (item ? 1 : 0)));
        result = boolValue(l.map((item, index) => Boolean(item) || Boolean(r[index] ?? r[0])));
      } else {
        result = intValue(applyBinary(a, b, (x, y) => (x | 0) | (y | 0), "int").data as number[]);
      }
      break;
    }
    case "math/xor": {
      const a = getInput(runtime, nodeId, "a", stack);
      const b = getInput(runtime, nodeId, "b", stack);
      result = intValue(applyBinary(a, b, (x, y) => (x | 0) ^ (y | 0), "int").data as number[]);
      break;
    }
    case "math/not": {
      const a = getInput(runtime, nodeId, "a", stack);
      if (a.type === "bool") {
        const out = (a.data as boolean[]).map((item) => !item);
        result = boolValue(out);
      } else {
        result = intValue(valueToNumberArray(a).map((item) => ~item));
      }
      break;
    }
    case "math/lsl":
      result = intValue(applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => (x | 0) << (y | 0), "int").data as number[]);
      break;
    case "math/asr":
      result = intValue(applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => (x | 0) >> (y | 0), "int").data as number[]);
      break;
    case "math/clz":
      result = intValue(applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.clz32(x), "int").data as number[]);
      break;
    case "math/ctz":
      result = intValue(applyUnary(getInput(runtime, nodeId, "a", stack), (x) => Math.clz32(x & -x) ^ 31, "int").data as number[]);
      break;
    case "math/popcnt":
      result = intValue(applyUnary(getInput(runtime, nodeId, "a", stack), (x) => {
        let v = x | 0;
        let count = 0;
        while (v) {
          count += v & 1;
          v >>= 1;
        }
        return count;
      }, "int").data as number[]);
      break;
    case "math/min":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => Math.min(x, y));
      break;
    case "math/max":
      result = applyBinary(getInput(runtime, nodeId, "a", stack), getInput(runtime, nodeId, "b", stack), (x, y) => Math.max(x, y));
      break;
    case "math/clamp": {
      const a = getInput(runtime, nodeId, "a", stack);
      const b = getInput(runtime, nodeId, "b", stack);
      const c = getInput(runtime, nodeId, "c", stack);
      const aNum = valueToNumberArray(a);
      const bNum = valueToNumberArray(b);
      const cNum = valueToNumberArray(c);
      const [low, high] = broadcast(bNum, cNum);
      const out = aNum.map((item, index) => Math.min(Math.max(item, low[index] ?? low[0]), high[index] ?? high[0]));
      result = floatValue(out);
      break;
    }
    case "math/mix": {
      const a = getInput(runtime, nodeId, "a", stack);
      const b = getInput(runtime, nodeId, "b", stack);
      const c = getInput(runtime, nodeId, "c", stack);
      const t = valueToNumberArray(c)[0] ?? 0;
      const out = valueToNumberArray(a).map((item, index) => item + (valueToNumberArray(b)[index] - item) * t);
      result = floatValue(out);
      break;
    }
    case "math/select": {
      const condition = getInput(runtime, nodeId, "condition", stack);
      const a = getInput(runtime, nodeId, "a", stack);
      const b = getInput(runtime, nodeId, "b", stack);
      const cond = valueToNumberArray(condition).map((item) => Boolean(item));
      const aNum = valueToNumberArray(a);
      const bNum = valueToNumberArray(b);
      if (cond.length === 1) {
        result = cond[0] ? cloneValue(a) : cloneValue(b);
      } else {
        const out = aNum.map((item, index) => (cond[index] ? item : bNum[index] ?? bNum[0]));
        result = floatValue(out);
      }
      break;
    }
    case "math/length": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const len = Math.hypot(...a);
      result = floatValue([len]);
      break;
    }
    case "math/dot": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      const len = Math.min(a.length, b.length);
      let sum = 0;
      for (let i = 0; i < len; i += 1) {
        sum += a[i] * b[i];
      }
      result = floatValue([sum]);
      break;
    }
    case "math/normalize": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      if (!a.every(Number.isFinite)) {
        setOutput(runtime, nodeId, "isValid", boolValue([false]));
        result = floatValue(a.map(() => 0));
        break;
      }
      const len = Math.hypot(...a);
      if (!len) {
        setOutput(runtime, nodeId, "isValid", boolValue([false]));
        result = floatValue(a.map(() => 0));
      } else {
        setOutput(runtime, nodeId, "isValid", boolValue([true]));
        result = floatValue(a.map((item) => item / len));
      }
      break;
    }
    case "math/isNaN": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = boolValue([a.some((item) => Number.isNaN(item))]);
      break;
    }
    case "math/isInf": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = boolValue([a.some((item) => !Number.isFinite(item))]);
      break;
    }
    case "math/saturate": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = floatValue(a.map((item) => Math.min(Math.max(item, 0), 1)));
      break;
    }
    case "math/E":
      result = floatValue([Math.E]);
      break;
    case "math/Pi":
      result = floatValue([Math.PI]);
      break;
    case "math/NaN":
      result = floatValue([NaN]);
      break;
    case "math/Inf":
      result = floatValue([Infinity]);
      break;
    case "math/random": {
      runtime.randomState = (1664525 * runtime.randomState + 1013904223) >>> 0;
      result = floatValue([runtime.randomState / 0xffffffff]);
      break;
    }
    case "math/combine2": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      result = { type: "float2", data: [a[0], b[0]] };
      break;
    }
    case "math/combine3": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      const c = valueToNumberArray(getInput(runtime, nodeId, "c", stack));
      result = { type: "float3", data: [a[0], b[0], c[0]] };
      break;
    }
    case "math/combine4": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      const c = valueToNumberArray(getInput(runtime, nodeId, "c", stack));
      const d = valueToNumberArray(getInput(runtime, nodeId, "d", stack));
      result = { type: "float4", data: [a[0], b[0], c[0], d[0]] };
      break;
    }
    case "math/combine4x4": {
      const values = ["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p"].map((key) => valueToNumberArray(getInput(runtime, nodeId, key, stack))[0]);
      result = { type: "float4x4", data: values };
      break;
    }
    case "math/extract2": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      setOutput(runtime, nodeId, "0", floatValue([a[0]]));
      setOutput(runtime, nodeId, "1", floatValue([a[1]]));
      result = floatValue([a[0]]);
      break;
    }
    case "math/extract3": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      setOutput(runtime, nodeId, "0", floatValue([a[0]]));
      setOutput(runtime, nodeId, "1", floatValue([a[1]]));
      setOutput(runtime, nodeId, "2", floatValue([a[2]]));
      result = floatValue([a[0]]);
      break;
    }
    case "math/extract4": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      setOutput(runtime, nodeId, "0", floatValue([a[0]]));
      setOutput(runtime, nodeId, "1", floatValue([a[1]]));
      setOutput(runtime, nodeId, "2", floatValue([a[2]]));
      setOutput(runtime, nodeId, "3", floatValue([a[3]]));
      result = floatValue([a[0]]);
      break;
    }
    case "math/extract4x4": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      for (let i = 0; i < 16; i += 1) {
        setOutput(runtime, nodeId, `${i}`, floatValue([a[i]]));
      }
      result = floatValue([a[0]]);
      break;
    }
    case "math/matMul": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      result = { type: "float4x4", data: mat4Mul(a, b) };
      break;
    }
    case "math/transpose": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = { type: "float4x4", data: mat4Transpose(a) };
      break;
    }
    case "math/determinant": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = floatValue([mat4Determinant(a)]);
      break;
    }
    case "math/inverse": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const { value, isValid } = mat4Invert(a);
      setOutput(runtime, nodeId, "isValid", boolValue([isValid]));
      result = { type: "float4x4", data: value };
      break;
    }
    case "math/transform": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      const matrix = a.length === 16 ? a : b;
      const vector = a.length === 16 ? b : a;
      const transformed = transformVec3(matrix, vector);
      result = vector.length === 4 ? { type: "float4", data: transformed } : { type: "float3", data: transformed.slice(0, 3) };
      break;
    }
    case "math/matCompose": {
      const t = valueToNumberArray(getInput(runtime, nodeId, "translation", stack));
      const r = valueToNumberArray(getInput(runtime, nodeId, "rotation", stack));
      const s = valueToNumberArray(getInput(runtime, nodeId, "scale", stack));
      result = { type: "float4x4", data: mat4Compose(t, r, s) };
      break;
    }
    case "math/matDecompose": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const { translation, rotation, scale, isValid } = mat4Decompose(a);
      setOutput(runtime, nodeId, "translation", { type: "float3", data: translation });
      setOutput(runtime, nodeId, "rotation", { type: "float4", data: rotation });
      setOutput(runtime, nodeId, "scale", { type: "float3", data: scale });
      setOutput(runtime, nodeId, "isValid", boolValue([isValid]));
      result = { type: "float3", data: translation };
      break;
    }
    case "math/quatMul": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      result = { type: "float4", data: quatMul(a, b) };
      break;
    }
    case "math/quatConjugate": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = { type: "float4", data: [-a[0], -a[1], -a[2], a[3]] };
      break;
    }
    case "math/quatFromAxisAngle": {
      const axis = valueToNumberArray(getInput(runtime, nodeId, "axis", stack));
      const angle = valueToNumberArray(getInput(runtime, nodeId, "angle", stack))[0] ?? 0;
      result = { type: "float4", data: quatFromAxisAngle(axis, angle) };
      break;
    }
    case "math/quatToAxisAngle": {
      const q = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const { axis, angle } = quatToAxisAngle(q);
      setOutput(runtime, nodeId, "axis", { type: "float3", data: axis });
      setOutput(runtime, nodeId, "angle", floatValue([angle]));
      result = { type: "float3", data: axis };
      break;
    }
    case "math/quatFromDirections": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      result = { type: "float4", data: quatFromDirections(a, b) };
      break;
    }
    case "math/quatFromUpForward": {
      const up = valueToNumberArray(getInput(runtime, nodeId, "up", stack));
      const forward = valueToNumberArray(getInput(runtime, nodeId, "forward", stack));
      result = { type: "float4", data: quatFromUpForward(up, forward) };
      break;
    }
    case "math/quatAngleBetween": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const b = valueToNumberArray(getInput(runtime, nodeId, "b", stack));
      result = floatValue([quatAngleBetween(a, b)]);
      break;
    }
    case "math/rotate2D": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const angle = valueToNumberArray(getInput(runtime, nodeId, "angle", stack))[0] ?? 0;
      result = { type: "float2", data: rotate2D(a, angle) };
      break;
    }
    case "math/rotate3D": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      const r = valueToNumberArray(getInput(runtime, nodeId, "rotation", stack));
      result = { type: "float3", data: rotate3D(a, r) };
      break;
    }
    case "math/switch": {
      const selection = valueToNumberArray(getInput(runtime, nodeId, "selection", stack))[0] ?? 0;
      const valueKey = `${selection}`;
      const value = getInputOptional(runtime, nodeId, valueKey, stack) ?? getInput(runtime, nodeId, "default", stack);
      result = cloneValue(value);
      break;
    }
    case "pointer/get": {
      const { value, isValid } = handlePointerGet(runtime, nodeId, stack);
      setOutput(runtime, nodeId, "isValid", boolValue([isValid]));
      result = value;
      break;
    }
    case "type/intToFloat": {
      const a = valueToNumberArray(getInput(runtime, nodeId, "a", stack));
      result = floatValue([a[0] ?? 0]);
      break;
    }
    case "variable/get": {
      const variableIndex = getConfigValue(node, "variable");
      const index = toIndex(variableIndex);
      result = cloneValue(runtime.variables[index] ?? defaultValue("float"));
      break;
    }
    case "event/onTick": {
      result = floatValue([runtime.time]);
      break;
    }
    case "event/onPointerMove":
    case "event/onPointerDown":
    case "event/onPointerUp": {
      if (socket === "x") {
        result = floatValue([runtime.pointerX]);
      } else if (socket === "y") {
        result = floatValue([runtime.pointerY]);
      } else if (socket === "position") {
        result = { type: "float2", data: [runtime.pointerX, runtime.pointerY] };
      }
      break;
    }
    case "event/receive": {
      const payload = getEventPayload(runtime, node);
      if (socket === "boolParameter") {
        result = boolValue([payload.boolParameter ?? false]);
      } else if (socket === "intParameter") {
        result = intValue([payload.intParameter ?? 0]);
      } else if (socket === "floatParameter") {
        result = floatValue([payload.floatParameter ?? 0]);
      } else if (socket === "expectedDuration") {
        result = floatValue([payload.expectedDuration ?? 0]);
      }
      break;
    }
    case "flow/for": {
      const state = runtime.nodeStates.get(nodeId);
      const initialIndex = getConfigValue(node, "initialIndex");
      const fallback = typeof initialIndex === "number" ? Math.trunc(initialIndex) : 0;
      const index = state?.forIndex ?? fallback;
      result = intValue([index]);
      break;
    }
    case "flow/doN": {
      const state = runtime.nodeStates.get(nodeId);
      const count = state?.doNCount ?? 0;
      result = intValue([count]);
      break;
    }
    case "flow/multiGate": {
      const state = runtime.nodeStates.get(nodeId);
      const lastIndex = state?.multiGateLastIndex ?? -1;
      result = intValue([lastIndex]);
      break;
    }
    case "flow/setDelay": {
      const state = runtime.nodeStates.get(nodeId);
      result = intValue([state?.lastDelayIndex ?? -1]);
      break;
    }
    case "flow/throttle": {
      const state = runtime.nodeStates.get(nodeId);
      const remaining = state?.throttleRemaining ?? Number.NaN;
      result = floatValue([remaining]);
      break;
    }
    case "flow/waitAll": {
      const state = runtime.nodeStates.get(nodeId);
      const inputFlows = Math.trunc((getConfigValue(node, "inputFlows") as number) ?? 0);
      const remaining = state?.remainingInputs ?? inputFlows;
      result = intValue([remaining]);
      break;
    }
    default:
      break;
  }

  const existing = getOutputCached(runtime, nodeId, socket);
  if (existing) {
    result = existing;
  }
  setOutput(runtime, nodeId, socket, result);
  stack.delete(key);
  return result;
}

function getInput(runtime: RuntimeGraph, nodeId: number, socket: string, stack: Set<string>): Value {
  const node = runtime.graph.nodes[nodeId];
  const entry = getNodeValue(runtime.graph, node, socket);
  if (!entry) {
    return defaultValue("float");
  }
  if ("node" in entry) {
    return evaluateValue(runtime, entry.node, entry.socket, stack);
  }
  return entry;
}

function getInputOptional(runtime: RuntimeGraph, nodeId: number, socket: string, stack: Set<string>): Value | null {
  const node = runtime.graph.nodes[nodeId];
  const entry = getNodeValue(runtime.graph, node, socket);
  if (!entry) {
    return null;
  }
  if ("node" in entry) {
    return evaluateValue(runtime, entry.node, entry.socket, stack);
  }
  return entry;
}

function extractPointerParams(pointer: string): string[] {
  const params: string[] = [];
  pointer.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (!params.includes(name)) {
      params.push(name);
    }
    return "";
  });
  return params;
}

function parsePointer(pointer: string, inputs: Record<string, number>) {
  return pointer.replace(/\{([^}]+)\}/g, (_, name: string) => String(inputs[name] ?? 0));
}

function decodePointerToken(token: string) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function computeNodeLocalMatrix(node: any): number[] {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    return node.matrix.map((v: any) => Number(v));
  }
  const t = Array.isArray(node?.translation) ? node.translation : [0, 0, 0];
  const r = Array.isArray(node?.rotation) ? node.rotation : [0, 0, 0, 1];
  const s = Array.isArray(node?.scale) ? node.scale : [1, 1, 1];
  return mat4Compose(t, r, s);
}

function computeNodeGlobalMatrix(gltf: any, nodeIndex: number, cache: Map<number, number[]>): number[] {
  if (cache.has(nodeIndex)) {
    return cache.get(nodeIndex) ?? mat4Identity();
  }
  const node = gltf.nodes?.[nodeIndex];
  const local = computeNodeLocalMatrix(node);
  const parentIndex = typeof node?.parent === "number" ? node.parent : -1;
  if (parentIndex >= 0) {
    const parentGlobal = computeNodeGlobalMatrix(gltf, parentIndex, cache);
    const global = mat4Mul(parentGlobal, local);
    cache.set(nodeIndex, global);
    return global;
  }
  cache.set(nodeIndex, local);
  return local;
}

function getMeshTargetCount(mesh: any): number {
  const primitives = mesh?.primitives;
  if (!Array.isArray(primitives) || primitives.length === 0) {
    return 0;
  }
  const targets = primitives[0]?.targets;
  return Array.isArray(targets) ? targets.length : 0;
}

function findMeshNodeIndex(data: any, startIndex: number): number | null {
  const nodes = data.nodes;
  if (!Array.isArray(nodes) || startIndex < 0 || startIndex >= nodes.length) {
    return null;
  }
  const visited = new Set<number>();
  const queue: number[] = [startIndex];
  while (queue.length > 0) {
    const index = queue.shift();
    if (index === undefined || visited.has(index)) {
      continue;
    }
    visited.add(index);
    const node = nodes[index];
    if (node && typeof node.mesh === "number") {
      return index;
    }
    const children = Array.isArray(node?.children) ? node.children : [];
    for (const child of children) {
      if (Number.isFinite(child)) {
        queue.push(child);
      }
    }
  }
  return null;
}

function resolvePointerValue(data: any, pointer: string): { value: any; isValid: boolean } {
  const tokens = pointer.split("/").filter(Boolean).map(decodePointerToken);
  let current: any = data;
  let nodeIndex: number | null = null;
  let meshIndex: number | null = null;
  const resolveWeightsLength = (nodeIdx: number | null, meshIdx: number | null) => {
    if (nodeIdx !== null) {
      const meshNodeIndex = findMeshNodeIndex(data, nodeIdx);
      const meshNode = meshNodeIndex !== null ? data.nodes?.[meshNodeIndex] : null;
      const mesh = meshNode && typeof meshNode.mesh === "number" ? data.meshes?.[meshNode.mesh] : null;
      if (!mesh) {
        return { value: 0, isValid: true };
      }
      const targetCount = getMeshTargetCount(mesh);
      if (Array.isArray(meshNode?.weights)) {
        return { value: meshNode.weights.length, isValid: true };
      }
      if (Array.isArray(mesh.weights)) {
        return { value: mesh.weights.length, isValid: true };
      }
      return { value: targetCount, isValid: true };
    }
    if (meshIdx !== null) {
      const mesh = data.meshes?.[meshIdx];
      if (!mesh) {
        return { value: 0, isValid: false };
      }
      const targetCount = getMeshTargetCount(mesh);
      if (Array.isArray(mesh.weights)) {
        return { value: mesh.weights.length, isValid: true };
      }
      return { value: targetCount, isValid: true };
    }
    return { value: 0, isValid: false };
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (current === undefined || current === null) {
      return { value: undefined, isValid: false };
    }
    if (token.endsWith(".length")) {
      const base = token.slice(0, -".length".length);
      if (base === "weights") {
        return resolveWeightsLength(nodeIndex, meshIndex);
      }
      if (!(base in current)) {
        return { value: 0, isValid: false };
      }
      current = current[base];
      return { value: Array.isArray(current) ? current.length : 0, isValid: Array.isArray(current) };
    }
    if ((token === "matrix" || token === "globalMatrix") && nodeIndex !== null) {
      const cache = new Map<number, number[]>();
      const matrix = token === "matrix"
        ? computeNodeLocalMatrix(data.nodes?.[nodeIndex])
        : computeNodeGlobalMatrix(data, nodeIndex, cache);
      return { value: matrix, isValid: true };
    }
    if (token === "[]") {
      return { value: undefined, isValid: false };
    }
    if (token === "weights") {
      const nextToken = tokens[i + 1];
      const hasIndex = nextToken !== undefined && !Number.isNaN(Number(nextToken));
      if (!hasIndex) {
        return { value: undefined, isValid: false };
      }
      if (nodeIndex !== null) {
        const meshNodeIndex = findMeshNodeIndex(data, nodeIndex);
        const meshNode = meshNodeIndex !== null ? data.nodes?.[meshNodeIndex] : null;
        const mesh = meshNode && typeof meshNode.mesh === "number" ? data.meshes?.[meshNode.mesh] : null;
        if (!mesh) {
          return { value: undefined, isValid: false };
        }
        const targetCount = getMeshTargetCount(mesh);
        if (Array.isArray(meshNode?.weights)) {
          current = meshNode.weights;
          continue;
        }
        if (Array.isArray(mesh.weights)) {
          current = mesh.weights;
          continue;
        }
        if (targetCount > 0) {
          current = new Array(targetCount).fill(0.5);
          continue;
        }
        current = [0];
        continue;
      }
      if (meshIndex !== null) {
        const mesh = data.meshes?.[meshIndex];
        if (!mesh) {
          return { value: undefined, isValid: false };
        }
        const targetCount = getMeshTargetCount(mesh);
        if (Array.isArray(mesh.weights)) {
          current = mesh.weights;
          continue;
        }
        if (targetCount > 0) {
          current = new Array(targetCount).fill(0.5);
          continue;
        }
        current = [0];
        continue;
      }
    }
    const index = Number(token);
    if (!Number.isNaN(index) && Array.isArray(current)) {
      if (index < 0 || index >= current.length) {
        return { value: undefined, isValid: false };
      }
      current = current[index];
      if (current && current === data.nodes?.[index]) {
        nodeIndex = index;
      }
      if (current && current === data.meshes?.[index]) {
        meshIndex = index;
      }
    } else {
      current = current[token];
      if (token === "nodes" && Array.isArray(current)) {
        // Next numeric token refers to a node index.
      }
      if (token === "meshes" && Array.isArray(current)) {
        // Next numeric token refers to a mesh index.
      }
    }
  }
  return { value: current, isValid: current !== undefined };
}

function setPointerValue(data: any, pointer: string, value: any): boolean {
  const tokens = pointer.split("/").filter(Boolean).map(decodePointerToken);
  let current: any = data;
  let parent: any = null;
  let parentKey: string | number | null = null;
  let nodeIndex: number | null = null;
  let meshIndex: number | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const isLast = i === tokens.length - 1;
    if (token.endsWith(".length")) {
      return false;
    }
    if (token === "globalMatrix") {
      return false;
    }
    if (token === "matrix" && isLast && nodeIndex !== null) {
      data.nodes[nodeIndex].matrix = value;
      return true;
    }
    const nextToken = tokens[i + 1];
    const nextIsIndex = nextToken !== undefined && !Number.isNaN(Number(nextToken));
    if (token === "weights") {
      if (!nextIsIndex) {
        return false;
      }
      if (nodeIndex !== null) {
        const meshNodeIndex = findMeshNodeIndex(data, nodeIndex);
        const meshNode = meshNodeIndex !== null ? data.nodes?.[meshNodeIndex] : null;
        const mesh = meshNode && typeof meshNode.mesh === "number" ? data.meshes?.[meshNode.mesh] : null;
        if (!mesh) {
          return false;
        }
        const targetCount = getMeshTargetCount(mesh);
        if (targetCount === 0) {
          return false;
        }
        if (!Array.isArray(meshNode.weights)) {
          if (Array.isArray(mesh.weights)) {
            meshNode.weights = [...mesh.weights];
          } else {
            meshNode.weights = new Array(targetCount).fill(0.5);
          }
        }
        if (Array.isArray(meshNode.weights)) {
          const nextWeights = new Array(targetCount);
          for (let j = 0; j < targetCount; j += 1) {
            const item = meshNode.weights[j];
            const num = Number(item);
            nextWeights[j] = Number.isFinite(num) ? num : 0;
          }
          meshNode.weights = nextWeights;
        }
        current = meshNode.weights;
        continue;
      }
      if (meshIndex !== null) {
        const mesh = data.meshes?.[meshIndex];
        if (!mesh) {
          return false;
        }
        const targetCount = getMeshTargetCount(mesh);
        if (targetCount === 0) {
          return false;
        }
        if (!Array.isArray(mesh.weights)) {
          mesh.weights = new Array(targetCount).fill(0.5);
        }
        if (Array.isArray(mesh.weights)) {
          const nextWeights = new Array(targetCount);
          for (let j = 0; j < targetCount; j += 1) {
            const item = mesh.weights[j];
            const num = Number(item);
            nextWeights[j] = Number.isFinite(num) ? num : 0;
          }
          mesh.weights = nextWeights;
        }
        current = mesh.weights;
        continue;
      }
      return false;
    }
    const index = Number(token);
    if (!Number.isNaN(index)) {
      if (!Array.isArray(current)) {
        const next: any[] = [];
        if (parent !== null && parentKey !== null) {
          parent[parentKey] = next;
        }
        current = next;
      }
      if (isLast) {
        current[index] = value;
      } else {
        current[index] = current[index] ?? {};
        parent = current;
        parentKey = index;
        current = current[index];
        if (current === data.nodes?.[index]) {
          nodeIndex = index;
        }
        if (current === data.meshes?.[index]) {
          meshIndex = index;
        }
      }
    } else {
      if (isLast) {
        current[token] = value;
      } else {
        current[token] = current[token] ?? (nextIsIndex ? [] : {});
        parent = current;
        parentKey = token;
        current = current[token];
        if (token === "nodes" && Array.isArray(current)) {
          // Next numeric token refers to a node index.
        }
        if (token === "meshes" && Array.isArray(current)) {
          // Next numeric token refers to a mesh index.
        }
      }
    }
  }
  return true;
}

function pointerValueMatchesType(value: any, signature: ValueType): boolean {
  if (signature === "bool") {
    return typeof value === "boolean";
  }
  if (signature === "int") {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  }
  if (signature === "float") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (signature === "float2") {
    return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v));
  }
  if (signature === "float3") {
    return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v));
  }
  if (signature === "float4") {
    return Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number" && Number.isFinite(v));
  }
  if (signature === "float4x4") {
    return Array.isArray(value) && value.length === 16 && value.every((v) => typeof v === "number" && Number.isFinite(v));
  }
  return false;
}

function handlePointerGet(runtime: RuntimeGraph, nodeId: number, stack: Set<string>) {
  const node = runtime.graph.nodes[nodeId];
  const pointer = getConfigValue(node, "pointer") as string | undefined;
  if (!pointer) {
    return { value: defaultValue("float"), isValid: false };
  }
  const typeIndex = getConfigValue(node, "type") as number | undefined;
  const signature = runtime.graph.types[typeIndex ?? 2]?.signature ?? "float";
  const params = extractPointerParams(pointer);
  const inputs: Record<string, number> = {};
  for (const param of params) {
    const raw = valueToNumberArray(getInput(runtime, nodeId, param, stack))[0] ?? 0;
    const value = Math.trunc(raw);
    if (!Number.isFinite(raw) || value < 0) {
      return { value: defaultValue(signature), isValid: false };
    }
    inputs[param] = value;
  }
  const resolved = parsePointer(pointer, inputs);
  const { value, isValid } = resolvePointerValue(runtime.gltf, resolved);
  if (!isValid || !pointerValueMatchesType(value, signature)) {
    return { value: defaultValue(signature), isValid: false };
  }
  const normalizedValue = Array.isArray(value) ? value : [value];
  return { value: toValue(signature, normalizedValue.map((item) => item ?? 0)), isValid: true };
}

function handlePointerSet(runtime: RuntimeGraph, nodeId: number, stack: Set<string>): boolean {
  const node = runtime.graph.nodes[nodeId];
  const pointer = getConfigValue(node, "pointer") as string | undefined;
  if (!pointer) {
    if (runtime.trace) {
      runtime.trace.push(-1000 - nodeId);
    }
    return false;
  }
  const valueInput = getInput(runtime, nodeId, "value", stack);
  const typeIndex = getConfigValue(node, "type") as number | undefined;
  const signature = runtime.graph.types[typeIndex ?? 2]?.signature ?? "float";
  const params = extractPointerParams(pointer);
  const inputs: Record<string, number> = {};
  for (const param of params) {
    const raw = valueToNumberArray(getInput(runtime, nodeId, param, stack))[0] ?? 0;
    const value = Math.trunc(raw);
    if (!Number.isFinite(raw) || value < 0) {
      if (runtime.trace) {
        runtime.trace.push(-2000 - nodeId);
      }
      return false;
    }
    inputs[param] = value;
  }
  const resolved = parsePointer(pointer, inputs);
  const value = valueInput.data.length === 1 ? valueInput.data[0] : valueInput.data;
  if (!pointerValueMatchesType(value, signature)) {
    if (runtime.trace) {
      runtime.trace.push(-3000 - nodeId);
    }
    return false;
  }
  const ok = setPointerValue(runtime.gltf, resolved, value);
  if (ok) {
    runtime.onPointerSet?.(resolved, value);
    runtime.onDirty?.();
  }
  if (!ok && runtime.trace) {
    runtime.trace.push(-4000 - nodeId);
  }
  return ok;
}

function getEventPayload(runtime: RuntimeGraph, node: GraphNode): EventPayload {
  const index = getConfigValue(node, "event") as number | undefined;
  if (index === undefined) {
    return {};
  }
  const payload = runtime.eventPayloads.get(index);
  if (payload) {
    return payload;
  }
  const eventDefaults = runtime.graph.events?.[index]?.values ?? {};
  return {
    boolParameter: Boolean(eventDefaults.boolParameter?.value?.[0] ?? false),
    intParameter: Number(eventDefaults.intParameter?.value?.[0] ?? 0),
    floatParameter: Number(eventDefaults.floatParameter?.value?.[0] ?? 0),
    expectedDuration: Number(eventDefaults.expectedDuration?.value?.[0] ?? 0)
  };
}
function runFlow(runtime: RuntimeGraph, node: GraphNode, socket: string) {
  const flow = node.flows?.[socket];
  if (flow) {
    executeFlow(runtime, flow.node, flow.socket);
  }
}

function executeNodeFlow(runtime: RuntimeGraph, nodeId: number, socket: string, queue: Array<{ nodeId: number; socket: string }>) {
  runtime.nodeOutputs.clear();
  if (runtime.trace) {
    runtime.trace.push(nodeId);
  }
  const node = runtime.graph.nodes[nodeId];
  const op = runtime.graph.declarations[node.declaration]?.op ?? "";
  const stack = new Set<string>();

  switch (op) {
    case "event/onStart":
      runFlow(runtime, node, "out");
      break;
    case "event/send": {
      const eventIndex = getConfigValue(node, "event") as number | undefined;
      if (eventIndex !== undefined) {
        const payload: EventPayload = {};
        if (node.values?.boolParameter) {
          payload.boolParameter = Boolean(valueToNumberArray(getInput(runtime, nodeId, "boolParameter", stack))[0]);
        }
        if (node.values?.intParameter) {
          payload.intParameter = Math.trunc(valueToNumberArray(getInput(runtime, nodeId, "intParameter", stack))[0] ?? 0);
        }
        if (node.values?.floatParameter) {
          payload.floatParameter = valueToNumberArray(getInput(runtime, nodeId, "floatParameter", stack))[0] ?? 0;
        }
        if (node.values?.expectedDuration) {
          payload.expectedDuration = valueToNumberArray(getInput(runtime, nodeId, "expectedDuration", stack))[0] ?? 0;
        }
        runtime.eventPayloads.set(eventIndex, payload);
        const receivers = runtime.eventReceivers.get(eventIndex) ?? [];
        for (const receiverId of receivers) {
          executeFlow(runtime, receiverId, "in");
        }
      }
      runFlow(runtime, node, "out");
      break;
    }
    case "event/receive":
      runFlow(runtime, node, "out");
      break;
    case "debug/log":
      runFlow(runtime, node, "out");
      break;
    case "flow/sequence": {
      if (socket !== "in") {
        break;
      }
      const flows = node.flows ?? {};
      const ordered = Object.keys(flows).sort();
      for (const key of ordered) {
        const flow = flows[key];
        executeFlow(runtime, flow.node, flow.socket);
      }
      break;
    }
    case "flow/branch": {
      if (socket !== "in") {
        break;
      }
      const condition = getInput(runtime, nodeId, "condition", stack);
      const cond = Boolean(valueToNumberArray(condition)[0]);
      runFlow(runtime, node, cond ? "true" : "false");
      break;
    }
    case "flow/switch": {
      if (socket !== "in") {
        break;
      }
      const selection = valueToNumberArray(getInput(runtime, nodeId, "selection", stack))[0] ?? 0;
      const key = `${selection}`;
      if (node.flows?.[key]) {
        executeFlow(runtime, node.flows[key].node, node.flows[key].socket);
      } else if (node.flows?.default) {
        executeFlow(runtime, node.flows.default.node, node.flows.default.socket);
      }
      break;
    }
    case "flow/for": {
      if (socket !== "in") {
        break;
      }
      const initialIndex = getConfigValue(node, "initialIndex");
      const state = runtime.nodeStates.get(nodeId) ?? {};
      if (state.forIndex === undefined) {
        state.forIndex = typeof initialIndex === "number" ? Math.trunc(initialIndex) : 0;
      }
      const startIndex = Math.trunc(valueToNumberArray(getInput(runtime, nodeId, "startIndex", stack))[0] ?? 0);
      state.forIndex = startIndex;
      runtime.nodeStates.set(nodeId, state);
      const loopBody = node.flows?.loopBody;
      const completed = node.flows?.completed;
      let iterations = 0;
      while (iterations < 10000) {
        runtime.nodeOutputs.clear();
        const endIndex = Math.trunc(valueToNumberArray(getInput(runtime, nodeId, "endIndex", stack))[0] ?? 0);
        if (state.forIndex >= endIndex) {
          break;
        }
        if (loopBody) {
          executeFlow(runtime, loopBody.node, loopBody.socket);
        }
        state.forIndex += 1;
        runtime.nodeStates.set(nodeId, state);
        iterations += 1;
      }
      if (completed) {
        queue.push({ nodeId: completed.node, socket: completed.socket });
      }
      break;
    }
    case "flow/doN": {
      const state = runtime.nodeStates.get(nodeId) ?? {};
      if (socket === "reset") {
        state.doNCount = 0;
        runtime.nodeStates.set(nodeId, state);
        break;
      }
      if (socket !== "in") {
        break;
      }
      const n = Math.trunc(valueToNumberArray(getInput(runtime, nodeId, "n", stack))[0] ?? 0);
      state.doNCount = state.doNCount ?? 0;
      if (state.doNCount < n) {
        state.doNCount += 1;
        runtime.nodeStates.set(nodeId, state);
        runFlow(runtime, node, "out");
      }
      break;
    }
    case "flow/while": {
      if (socket !== "in") {
        break;
      }
      const loopBody = node.flows?.loopBody;
      const completed = node.flows?.completed;
      let iterations = 0;
      while (iterations < 10000) {
        runtime.nodeOutputs.clear();
        const condition = Boolean(valueToNumberArray(getInput(runtime, nodeId, "condition", stack))[0]);
        if (!condition) {
          break;
        }
        if (loopBody) {
          executeFlow(runtime, loopBody.node, loopBody.socket);
        }
        iterations += 1;
      }
      if (completed) {
        queue.push({ nodeId: completed.node, socket: completed.socket });
      }
      break;
    }
    case "flow/multiGate": {
      const flows = node.flows ?? {};
      const outputs = Object.keys(flows).sort();
      const state = runtime.nodeStates.get(nodeId) ?? {};
      if (socket === "reset") {
        state.multiGateLastIndex = -1;
        state.multiGateUsed = new Array(outputs.length).fill(false);
        runtime.nodeStates.set(nodeId, state);
        break;
      }
      if (socket !== "in") {
        break;
      }
      if (outputs.length === 0) {
        break;
      }
      if (!state.multiGateUsed || state.multiGateUsed.length !== outputs.length) {
        state.multiGateUsed = new Array(outputs.length).fill(false);
      }
      const isRandom = Boolean(getConfigValue(node, "isRandom"));
      const isLoop = Boolean(getConfigValue(node, "isLoop"));
      let index = -1;
      if (!isRandom) {
        index = state.multiGateUsed.findIndex((used) => !used);
      } else {
        const available = state.multiGateUsed
          .map((used, idx) => (!used ? idx : -1))
          .filter((idx) => idx >= 0);
        if (available.length > 0) {
          runtime.randomState = (1664525 * runtime.randomState + 1013904223) >>> 0;
          index = available[runtime.randomState % available.length];
        }
      }
      if (index === -1 && isLoop) {
        state.multiGateUsed = new Array(outputs.length).fill(false);
        if (!isRandom) {
          index = 0;
        } else {
          runtime.randomState = (1664525 * runtime.randomState + 1013904223) >>> 0;
          index = runtime.randomState % outputs.length;
        }
      }
      if (index >= 0) {
        state.multiGateUsed[index] = true;
        state.multiGateLastIndex = index;
        runtime.nodeStates.set(nodeId, state);
        const key = outputs[index];
        const flow = flows[key];
        if (flow) {
          executeFlow(runtime, flow.node, flow.socket);
        }
      } else {
        runtime.nodeStates.set(nodeId, state);
      }
      break;
    }
    case "flow/waitAll": {
      const inputFlows = Math.trunc((getConfigValue(node, "inputFlows") as number) ?? 0);
      const state = runtime.nodeStates.get(nodeId) ?? {};
      state.waitAllActivated = state.waitAllActivated ?? new Array(inputFlows).fill(false);
      if (socket === "reset") {
        state.waitAllActivated.fill(false);
        state.remainingInputs = inputFlows;
        runtime.nodeStates.set(nodeId, state);
        break;
      }
      const index = Number(socket);
      if (!Number.isFinite(index)) {
        break;
      }
      if (Number.isFinite(index) && index >= 0 && index < inputFlows) {
        if (!state.waitAllActivated[index]) {
          state.waitAllActivated[index] = true;
          state.remainingInputs = (state.remainingInputs ?? inputFlows) - 1;
        }
      }
      const remaining = state.remainingInputs ?? inputFlows;
      runtime.nodeStates.set(nodeId, state);
      if (remaining <= 0) {
        const flow = node.flows?.completed;
        if (flow) {
          executeFlow(runtime, flow.node, flow.socket);
        }
      } else {
        const flow = node.flows?.out;
        if (flow) {
          executeFlow(runtime, flow.node, flow.socket);
        }
      }
      break;
    }
    case "flow/setDelay": {
      const state = runtime.nodeStates.get(nodeId) ?? {};
      state.delayIds = state.delayIds ?? [];
      if (socket === "cancel") {
        const cancelIds = new Set(state.delayIds);
        runtime.delays = runtime.delays.filter((item) => !cancelIds.has(item.id));
        state.delayIds = [];
        state.lastDelayIndex = -1;
        runtime.nodeStates.set(nodeId, state);
        break;
      }
      if (socket !== "in") {
        break;
      }
      const duration = valueToNumberArray(getInput(runtime, nodeId, "duration", stack))[0] ?? 0;
      if (!Number.isFinite(duration) || duration < 0) {
        runFlow(runtime, node, "err");
        break;
      }
      const delayId = runtime.nextDelayId;
      runtime.nextDelayId += 1;
      state.lastDelayIndex = delayId;
      state.delayIds.push(delayId);
      runtime.nodeStates.set(nodeId, state);
      const doneFlow = node.flows?.done;
      if (doneFlow) {
        runtime.delays.push({
          id: delayId,
          time: runtime.time + duration,
          nodeId: doneFlow.node,
          socket: doneFlow.socket,
          canceled: false,
          ownerNodeId: nodeId
        });
      }
      runFlow(runtime, node, "out");
      break;
    }
    case "flow/cancelDelay": {
      if (socket !== "in") {
        break;
      }
      const delayIndex = Math.trunc(valueToNumberArray(getInput(runtime, nodeId, "delayIndex", stack))[0] ?? -1);
      const delay = runtime.delays.find((item) => item.id === delayIndex);
      if (delay) {
        runtime.delays = runtime.delays.filter((item) => item.id !== delayIndex);
        const ownerState = runtime.nodeStates.get(delay.ownerNodeId);
        if (ownerState?.delayIds) {
          ownerState.delayIds = ownerState.delayIds.filter((id) => id !== delayIndex);
          runtime.nodeStates.set(delay.ownerNodeId, ownerState);
        }
      }
      runFlow(runtime, node, "out");
      break;
    }
    case "flow/throttle": {
      const state = runtime.nodeStates.get(nodeId) ?? {};
      if (socket === "reset") {
        state.throttleTime = undefined;
        state.throttleRemaining = Number.NaN;
        runtime.nodeStates.set(nodeId, state);
        break;
      }
      if (socket !== "in") {
        break;
      }
      const duration = valueToNumberArray(getInput(runtime, nodeId, "duration", stack))[0] ?? 0;
      if (!Number.isFinite(duration) || duration < 0) {
        runFlow(runtime, node, "err");
        break;
      }
      const last = state.throttleTime ?? -Infinity;
      const elapsed = runtime.time - last;
      if (elapsed >= duration) {
        state.throttleTime = runtime.time;
        state.throttleRemaining = 0;
        runtime.nodeStates.set(nodeId, state);
        runFlow(runtime, node, "out");
      } else {
        state.throttleTime = last;
        state.throttleRemaining = Math.max(0, duration - elapsed);
        runtime.nodeStates.set(nodeId, state);
      }
      break;
    }
    case "pointer/set":
      if (handlePointerSet(runtime, nodeId, stack)) {
        runFlow(runtime, node, "out");
      } else {
        runFlow(runtime, node, "err");
      }
      break;
    case "variable/set": {
      const variables = getConfigValue(node, "variables");
      const indices = Array.isArray(variables) ? variables : [variables ?? 0];
      for (const index of indices) {
        const resolvedIndex = toIndex(index);
        const key = String(resolvedIndex);
        const value = getInput(runtime, nodeId, key, stack);
        runtime.variables[resolvedIndex] = cloneValue(value);
      }
      runFlow(runtime, node, "out");
      break;
    }
    case "variable/interpolate": {
      const variableIndex = getConfigValue(node, "variable");
      const useSlerp = Boolean(getConfigValue(node, "useSlerp"));
      const duration = valueToNumberArray(getInput(runtime, nodeId, "duration", stack))[0] ?? 0;
      const value = getInput(runtime, nodeId, "value", stack);
      const p1 = valueToNumberArray(getInput(runtime, nodeId, "p1", stack));
      const p2 = valueToNumberArray(getInput(runtime, nodeId, "p2", stack));
      const isValid = duration > 0 && Number.isFinite(duration) && isFiniteValue(value) && p1.every(Number.isFinite) && p2.every(Number.isFinite);
      if (!isValid) {
        runFlow(runtime, node, "err");
        break;
      }
      const index = toIndex(variableIndex);
      const startValue = cloneValue(runtime.variables[index] ?? defaultValue(value.type));
      const endValue = cloneValue(value);
      runtime.interpolations.push({
        variableIndex: index,
        startTime: runtime.time,
        duration,
        startValue,
        endValue,
        p1: [p1[0] ?? 0, p1[1] ?? 0],
        p2: [p2[0] ?? 0, p2[1] ?? 0],
        useSlerp,
        doneFlow: node.flows?.done,
        errFlow: node.flows?.err
      });
      runFlow(runtime, node, "out");
      break;
    }
    default:
      runFlow(runtime, node, "out");
      break;
  }
}

function executeFlow(runtime: RuntimeGraph, nodeId: number, socket = "in") {
  runtime.nodeOutputs.clear();
  const queue: Array<{ nodeId: number; socket: string }> = [{ nodeId, socket }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    executeNodeFlow(runtime, item.nodeId, item.socket, queue);
  }
}

function advanceTime(runtime: RuntimeGraph, delta: number) {
  runtime.time += delta;
  runtime.interpolations = runtime.interpolations.filter((interp) => {
    const t = Math.min(1, (runtime.time - interp.startTime) / interp.duration);
    const ease = bezierY(t, interp.p1, interp.p2);
    if (interp.useSlerp && interp.startValue.type === "float4" && interp.endValue.type === "float4") {
      const q = quatSlerp(valueToNumberArray(interp.startValue), valueToNumberArray(interp.endValue), ease);
      runtime.variables[interp.variableIndex] = { type: "float4", data: q };
    } else {
      const start = valueToNumberArray(interp.startValue);
      const end = valueToNumberArray(interp.endValue);
      const out = start.map((item, index) => item + (end[index] - item) * ease);
      runtime.variables[interp.variableIndex] = { type: interp.endValue.type, data: out } as Value;
    }
    if (t >= 1) {
      if (interp.doneFlow) {
        executeFlow(runtime, interp.doneFlow.node, interp.doneFlow.socket);
      }
      return false;
    }
    return true;
  });
  const ready = runtime.delays.filter((item) => !item.canceled && item.time <= runtime.time);
  runtime.delays = runtime.delays.filter((item) => !item.canceled && item.time > runtime.time);
  for (const item of ready) {
    const ownerState = runtime.nodeStates.get(item.ownerNodeId);
    if (ownerState?.delayIds) {
      ownerState.delayIds = ownerState.delayIds.filter((id) => id !== item.id);
      runtime.nodeStates.set(item.ownerNodeId, ownerState);
    }
    executeFlow(runtime, item.nodeId, item.socket);
  }
}

function runEntryPoint(runtime: RuntimeGraph, entry: { nodeId: number; delayedExecutionTime?: number }, options: ExecuteOptions) {
  runtime.time = 0;
  runtime.delays = [];
  runtime.interpolations = [];
  runtime.nodeStates.clear();
  runtime.nodeOutputs.clear();
  runtime.eventPayloads.clear();
  executeFlow(runtime, entry.nodeId);
  const delay = entry.delayedExecutionTime ?? 0;
  if (delay <= 0) {
    advanceTime(runtime, 0);
    return;
  }
  while (runtime.time + 1e-6 < delay) {
    let nextTime = delay;
    if (runtime.delays.length > 0) {
      const soonest = Math.min(...runtime.delays.filter((item) => !item.canceled).map((item) => item.time));
      if (Number.isFinite(soonest)) {
        nextTime = Math.min(nextTime, soonest);
      }
    }
    if (runtime.interpolations.length > 0) {
      const soonestInterp = Math.min(...runtime.interpolations.map((interp) => interp.startTime + interp.duration));
      if (Number.isFinite(soonestInterp)) {
        nextTime = Math.min(nextTime, soonestInterp);
      }
    }
    const delta = Math.max(0, nextTime - runtime.time);
    if (delta === 0) {
      advanceTime(runtime, options.tickStep ?? 1 / 60);
    } else {
      advanceTime(runtime, delta);
    }
  }
}

export function createRuntime(graph: Graph, gltf: any, options: { onPointerSet?: RuntimeGraph["onPointerSet"]; onDirty?: RuntimeGraph["onDirty"] } = {}): RuntimeGraph {
  const variables = graph.variables.map((variable) => {
    const signature = graph.types[variable.type]?.signature ?? "float";
    if (!Array.isArray(variable.value)) {
      return defaultValue(signature);
    }
    return toValue(signature, variable.value);
  });
  const eventReceivers = new Map<number, number[]>();
  graph.nodes.forEach((node, index) => {
    const op = graph.declarations[node.declaration]?.op ?? "";
    if (op === "event/receive") {
      const eventIndex = getConfigValue(node, "event") as number | undefined;
      if (eventIndex !== undefined) {
        const list = eventReceivers.get(eventIndex) ?? [];
        list.push(index);
        eventReceivers.set(eventIndex, list);
      }
    }
  });
  return {
    graph,
    variables,
    nodeStates: new Map(),
    nodeOutputs: new Map(),
    eventPayloads: new Map(),
    time: 0,
    pointerX: 0,
    pointerY: 0,
    delays: [],
    interpolations: [],
    gltf: prepareGltfData(gltf),
    eventReceivers,
    randomState: 123456789,
    nextDelayId: 0,
    onPointerSet: options.onPointerSet,
    onDirty: options.onDirty
  };
}
export { executeFlow, advanceTime };
