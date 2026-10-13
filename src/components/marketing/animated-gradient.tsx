/*
 * Adapted from Spell UI's Animated Gradient component:
 * https://github.com/xxtomm/spell-ui/blob/main/registry/spell-ui/animated-gradient.tsx
 * Copyright (c) 2025 Spell UI
 *
 * MIT License
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { useEffect, useMemo, useRef } from "react"

import { cn } from "#/lib/utils"

type TexturePattern = "Checks" | "Stripes" | "Edge"

type PresetName = "Plasma" | "Mist"

interface GradientParameters {
  color1: string
  color2: string
  color3: string
  rotation: number
  proportion: number
  scale: number
  speed: number
  distortion: number
  swirl: number
  swirlIterations: number
  softness: number
  offset: number
  pattern: TexturePattern
  patternSize: number
}

type AnimatedGradientConfig = {
  preset: PresetName
} & Partial<GradientParameters>

interface AnimatedGradientProps {
  config: AnimatedGradientConfig
  className?: string
}

const PRESETS: Record<PresetName, GradientParameters> = {
  Plasma: {
    color1: "#b566ff",
    color2: "#000000",
    color3: "#000000",
    rotation: 0,
    proportion: 63,
    scale: 0.75,
    speed: 30,
    distortion: 5,
    swirl: 61,
    swirlIterations: 5,
    softness: 100,
    offset: -168,
    pattern: "Checks",
    patternSize: 28,
  },
  Mist: {
    color1: "#050505",
    color2: "#d1d1d1",
    color3: "#050505",
    rotation: 0,
    proportion: 33,
    scale: 0.48,
    speed: 39,
    distortion: 4,
    swirl: 65,
    swirlIterations: 5,
    softness: 100,
    offset: -235,
    pattern: "Edge",
    patternSize: 48,
  },
}

const PATTERN_VALUES: Record<TexturePattern, number> = {
  Checks: 0,
  Stripes: 1,
  Edge: 2,
}

const MAX_CANVAS_PIXELS = 1_200_000

export default function AnimatedGradient({
  config,
  className,
}: AnimatedGradientProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestRenderRef = useRef<(() => void) | null>(null)

  const parameters = useMemo<GradientParameters>(() => {
    const { preset: presetName, ...overrides } = config

    return {
      ...PRESETS[presetName],
      ...overrides,
    }
  }, [config])

  const parametersRef = useRef(parameters)

  // oxlint-disable-next-line max-statements -- WebGL resources, observers, and cleanup share this renderer lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current

    if (canvas === null || container === null) {
      return undefined
    }

    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
    })

    // The CSS hero/footer surfaces remain visible when WebGL 2 is unavailable.
    if (gl === null) {
      return undefined
    }

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)

    const fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      FRAGMENT_SHADER
    )

    const program = gl.createProgram()

    if (vertexShader === null || fragmentShader === null || program === null) {
      if (vertexShader !== null) {
        gl.deleteShader(vertexShader)
      }

      if (fragmentShader !== null) {
        gl.deleteShader(fragmentShader)
      }

      if (program !== null) {
        gl.deleteProgram(program)
      }

      return undefined
    }

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)

      return undefined
    }

    // oxlint-disable-next-line react/hooks -- This is the WebGL context method, not a React hook.
    gl["useProgram"](program)

    const positionBuffer = gl.createBuffer()

    if (positionBuffer === null) {
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)

      return undefined
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    )

    const positionLocation = gl.getAttribLocation(program, "a_position")

    if (positionLocation < 0) {
      gl.deleteBuffer(positionBuffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)

      return undefined
    }

    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    const uniforms = {
      time: gl.getUniformLocation(program, "u_time"),
      resolution: gl.getUniformLocation(program, "u_resolution"),
      pixelRatio: gl.getUniformLocation(program, "u_pixelRatio"),
      scale: gl.getUniformLocation(program, "u_scale"),
      rotation: gl.getUniformLocation(program, "u_rotation"),
      color1: gl.getUniformLocation(program, "u_color1"),
      color2: gl.getUniformLocation(program, "u_color2"),
      color3: gl.getUniformLocation(program, "u_color3"),
      proportion: gl.getUniformLocation(program, "u_proportion"),
      softness: gl.getUniformLocation(program, "u_softness"),
      pattern: gl.getUniformLocation(program, "u_shape"),
      patternScale: gl.getUniformLocation(program, "u_shapeScale"),
      distortion: gl.getUniformLocation(program, "u_distortion"),
      swirl: gl.getUniformLocation(program, "u_swirl"),
      swirlIterations: gl.getUniformLocation(program, "u_swirlIterations"),
    }

    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    )

    const startedAt = performance.now()
    let frameId: number | undefined
    let visible = true
    let canvasPixelRatio = 1

    const isActive = () =>
      visible && !document.hidden && !motionPreference.matches

    const draw = (time: number) => {
      const { current } = parametersRef

      const [color1, color2, color3] = [
        hexToRgba(current.color1),
        hexToRgba(current.color2),
        hexToRgba(current.color3),
      ]

      gl.uniform1f(
        uniforms.time,
        ((time - startedAt) / 1000) * (current.speed / 100) * 5 +
          current.offset * 0.01
      )
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
      gl.uniform1f(uniforms.pixelRatio, canvasPixelRatio)
      gl.uniform1f(uniforms.scale, current.scale)
      gl.uniform1f(uniforms.rotation, (current.rotation * Math.PI) / 180)
      gl.uniform4f(uniforms.color1, ...color1)
      gl.uniform4f(uniforms.color2, ...color2)
      gl.uniform4f(uniforms.color3, ...color3)
      gl.uniform1f(uniforms.proportion, current.proportion / 100)
      gl.uniform1f(uniforms.softness, current.softness / 100)
      gl.uniform1f(uniforms.pattern, PATTERN_VALUES[current.pattern])
      gl.uniform1f(uniforms.patternScale, current.patternSize / 100)
      gl.uniform1f(uniforms.distortion, current.distortion / 50)
      gl.uniform1f(uniforms.swirl, current.swirl / 100)
      gl.uniform1f(
        uniforms.swirlIterations,
        current.swirl === 0 ? 0 : current.swirlIterations
      )

      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    const stop = () => {
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId)
        frameId = undefined
      }
    }

    const animate = (time: number) => {
      frameId = undefined

      if (!isActive()) {
        return
      }

      draw(time)
      frameId = requestAnimationFrame(animate)
    }

    const render = () => {
      draw(performance.now())

      if (isActive() && frameId === undefined) {
        frameId = requestAnimationFrame(animate)
      }
    }

    const resize = () => {
      const width = Math.max(1, container.clientWidth)
      const height = Math.max(1, container.clientHeight)

      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        1.5,
        Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
      )

      canvasPixelRatio = pixelRatio
      canvas.width = Math.max(1, Math.round(width * pixelRatio))
      canvas.height = Math.max(1, Math.round(height * pixelRatio))
      gl.viewport(0, 0, canvas.width, canvas.height)
      render()
    }

    const resizeObserver = new ResizeObserver(resize)

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false

      if (visible) {
        render()
      } else {
        stop()
      }
    })

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
      } else {
        render()
      }
    }

    const onMotionPreferenceChange = () => {
      if (motionPreference.matches) {
        stop()
      }

      render()
    }

    resizeObserver.observe(container)
    intersectionObserver.observe(container)
    document.addEventListener("visibilitychange", onVisibilityChange)
    motionPreference.addEventListener("change", onMotionPreferenceChange)
    requestRenderRef.current = render
    resize()

    return () => {
      stop()
      requestRenderRef.current = null
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      motionPreference.removeEventListener("change", onMotionPreferenceChange)
      gl.deleteBuffer(positionBuffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
    }
  }, [])

  useEffect(() => {
    parametersRef.current = parameters
    requestRenderRef.current?.()
  }, [parameters])

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={cn("absolute inset-0 z-0 overflow-hidden", className)}
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  )
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
) {
  const shader = gl.createShader(type)

  if (shader === null) {
    return null
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)

    return null
  }

  return shader
}

function hexToRgba(hex: string): [number, number, number, number] {
  const normalized = hex.replace(/^#/, "")

  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : normalized

  const value = Number.parseInt(expanded, 16)

  if (!Number.isFinite(value) || expanded.length !== 6) {
    return [0, 0, 0, 1]
  }

  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
    1,
  ]
}

const VERTEX_SHADER = `#version 300 es
in vec4 a_position;
void main() {
  gl_Position = a_position;
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform float u_time;
uniform float u_pixelRatio;
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_rotation;
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform vec4 u_color3;
uniform float u_proportion;
uniform float u_softness;
uniform float u_shape;
uniform float u_shapeScale;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_swirlIterations;

out vec4 fragColor;

#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846

vec2 rotate(vec2 uv, float th) {
  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = random(i);
  float b = random(i + vec2(1.0, 0.0));
  float c = random(i + vec2(0.0, 1.0));
  float d = random(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}

vec4 blend_colors(
  vec4 c1,
  vec4 c2,
  vec4 c3,
  float mixer,
  float edgesWidth,
  float edge_blur
) {
  vec3 color1 = c1.rgb * c1.a;
  vec3 color2 = c2.rgb * c2.a;
  vec3 color3 = c3.rgb * c3.a;
  float r1 = smoothstep(
    0.0 + 0.35 * edgesWidth,
    0.7 - 0.35 * edgesWidth + 0.5 * edge_blur,
    mixer
  );
  float r2 = smoothstep(
    0.3 + 0.35 * edgesWidth,
    1.0 - 0.35 * edgesWidth + edge_blur,
    mixer
  );
  vec3 blended_color_2 = mix(color1, color2, r1);
  float blended_opacity_2 = mix(c1.a, c2.a, r1);
  vec3 color = mix(blended_color_2, color3, r2);
  float opacity = mix(blended_opacity_2, c3.a, r2);
  return vec4(color, opacity);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = 0.5 * u_time;
  float noise_scale = 0.0005 + 0.006 * u_scale;
  uv -= 0.5;
  uv *= noise_scale * u_resolution;
  uv = rotate(uv, u_rotation * 0.5 * PI);
  uv /= u_pixelRatio;
  uv += 0.5;

  float n1 = noise(uv + t);
  float n2 = noise(uv * 2.0 - t);
  float angle = n1 * TWO_PI;
  uv.x += 4.0 * u_distortion * n2 * cos(angle);
  uv.y += 4.0 * u_distortion * n2 * sin(angle);

  float iterations_number = ceil(clamp(u_swirlIterations, 1.0, 30.0));
  for (float i = 1.0; i <= iterations_number; i++) {
    uv.x += clamp(u_swirl, 0.0, 2.0) / i * cos(t + i * 1.5 * uv.y);
    uv.y += clamp(u_swirl, 0.0, 2.0) / i * cos(t + i * uv.x);
  }

  float proportion = clamp(u_proportion, 0.0, 1.0);
  float shape = 0.0;
  float mixer = 0.0;

  if (u_shape < 0.5) {
    vec2 shape_uv = uv * (0.5 + 3.5 * u_shapeScale);
    shape = 0.5 + 0.5 * sin(shape_uv.x) * cos(shape_uv.y);
    mixer = shape +
      0.48 * sign(proportion - 0.5) * pow(abs(proportion - 0.5), 0.5);
  } else if (u_shape < 1.5) {
    vec2 shape_uv = uv * (0.25 + 3.0 * u_shapeScale);
    float f = fract(shape_uv.y);
    shape = smoothstep(0.0, 0.55, f) * smoothstep(1.0, 0.45, f);
    mixer = shape +
      0.48 * sign(proportion - 0.5) * pow(abs(proportion - 0.5), 0.5);
  } else {
    float edge = 1.0 - uv.y;
    edge -= 0.5;
    edge /= noise_scale * u_resolution.y;
    edge += 0.5;
    float shape_scaling = 0.2 * (1.0 - u_shapeScale);
    shape = smoothstep(
      0.45 - shape_scaling,
      0.55 + shape_scaling,
      edge + 0.3 * (proportion - 0.5)
    );
    mixer = shape;
  }

  vec4 color = blend_colors(
    u_color1,
    u_color2,
    u_color3,
    mixer,
    1.0 - clamp(u_softness, 0.0, 1.0),
    0.01 + 0.01 * u_scale
  );
  fragColor = color;
}`
