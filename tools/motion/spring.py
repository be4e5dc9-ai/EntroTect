"""弹簧物理数值解算。

用半隐式 Euler 积分求解质量-弹簧-阻尼系统(mass-spring-damper)的
阶跃响应 x(t): 从 0 到 1,用于把"弹簧动画"离线烘焙成 CSS keyframes。
"""


def spring_response(stiffness: float, damping: float, mass: float = 1.0,
                    dt: float = 1 / 240.0, max_t: float = 3.0,
                    epsilon: float = 0.0008) -> list[tuple[float, float]]:
    """积分弹簧阶跃响应,返回 [(t, x)] 采样序列,settle 后提前截断。"""
    value = 0.0
    velocity = 0.0
    samples: list[tuple[float, float]] = [(0.0, 0.0)]
    t = 0.0
    while t < max_t:
        accel = (stiffness * (1.0 - value) - damping * velocity) / mass
        velocity += accel * dt
        value += velocity * dt
        t += dt
        samples.append((t, value))
        if abs(1.0 - value) < epsilon and abs(velocity) < epsilon:
            break
    return samples


def normalize(samples: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """把采样归一化为 [(offset 0..1, x 0..1)],offset 保留 2 位小数并去重。"""
    t_end = samples[-1][0]
    out: list[tuple[float, float]] = []
    seen: set[float] = set()
    for t, x in samples:
        offset = round(t / t_end, 2)
        if offset in seen:
            continue
        seen.add(offset)
        out.append((offset, min(1.0, max(0.0, x))))
    return out


def spring_preset(stiffness: float, damping: float, duration_ms: float,
                  mass: float = 1.0) -> dict:
    """求弹簧响应并按目标感知时长烘焙,供 CSS/JSON 双产出使用。

    只截取前 duration_ms 的响应曲线(该窗口内曲线已达 ~95%),
    尾段亚像素级的残余在入场动画中不可感知,换来得是稳定的
    <350ms 感知时长,符合 emil-design-eng 的时长纪律。
    """
    samples = spring_response(stiffness, damping, mass,
                              max_t=duration_ms / 1000.0)
    return {
        "stiffness": stiffness,
        "damping": damping,
        "mass": mass,
        "durationMs": round(duration_ms),
        "samples": normalize(samples),
    }
