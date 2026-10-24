//! JavaScript-exact number helpers.
//!
//! The offline simulator must draw the same API latencies and the same synthetic grid as
//! `scripts/greenops/mock.mjs`, and the controller must round the same way as the JS one, so a
//! single last-bit difference can't cascade into a different decision. `Math.log`, `Math.exp`,
//! `Math.cos` and `Math.pow` are therefore ports of the fdlibm routines V8 ships
//! (`src/base/ieee754.cc`), not the platform libm. `tests/jsmath.rs` checks them bit for bit
//! against Node on millions of inputs.

// A faithful port of C: the constants are fdlibm's (split ln2, 2/pi, ...), `x - x` makes NaN.
#![allow(clippy::excessive_precision, clippy::approx_constant, clippy::eq_op, clippy::collapsible_if, clippy::neg_cmp_op_on_partial_ord)]

use std::sync::atomic::{AtomicBool, Ordering};

// V8's C++ math is compiled with the platform's default floating-point contraction. Node's macOS
// arm64 build (clang, -ffp-contract=on) fuses `a*b + c` within one C expression into a single FMA;
// x86-64 builds have no FMA. `ma` marks exactly the products clang fuses, so `FMA = false` gives
// plain fdlibm and `FMA = true` gives the arm64 results.
static FMA: AtomicBool = AtomicBool::new(cfg!(target_arch = "aarch64"));

/// Select the contraction variant (default: FMA on aarch64, plain elsewhere, like official Node builds).
pub fn set_fma(on: bool) {
    FMA.store(on, Ordering::Relaxed);
}
pub fn fma_enabled() -> bool {
    FMA.load(Ordering::Relaxed)
}

/// `a*b + c` as clang emits it for one C expression: fused when contraction is on.
#[inline(always)]
fn ma<const F: bool>(a: f64, b: f64, c: f64) -> f64 {
    if F { a.mul_add(b, c) } else { a * b + c }
}

#[inline]
fn hi(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}
#[inline]
fn lo(x: f64) -> u32 {
    x.to_bits() as u32
}
#[inline]
fn from_words(h: u32, l: u32) -> f64 {
    f64::from_bits(((h as u64) << 32) | l as u64)
}
#[inline]
fn set_hi(x: f64, h: u32) -> f64 {
    from_words(h, lo(x))
}
#[inline]
fn set_lo(x: f64, l: u32) -> f64 {
    from_words(hi(x) as u32, l)
}

/// `Math.log` (fdlibm `__ieee754_log`).
pub fn log(x: f64) -> f64 {
    if fma_enabled() { log_v::<true>(x) } else { log_v::<false>(x) }
}

pub fn log_v<const F: bool>(x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const TWO54: f64 = 1.80143985094819840000e+16;
    const LG1: f64 = 6.666666666666735130e-01;
    const LG2: f64 = 3.999999999940941908e-01;
    const LG3: f64 = 2.857142874366239149e-01;
    const LG4: f64 = 2.222219843214978396e-01;
    const LG5: f64 = 1.818357216161805012e-01;
    const LG6: f64 = 1.531383769920937332e-01;
    const LG7: f64 = 1.479819860511658591e-01;

    let mut x = x;
    let mut hx = hi(x);
    let lx = lo(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = hi(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    x = set_hi(x, (hx | (i ^ 0x3ff0_0000)) as u32);
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = k as f64;
            return ma::<F>(dk, LN2_HI, dk * LN2_LO);
        }
        let r = f * f * ma::<F>(-0.33333333333333333, f, 0.5);
        if k == 0 {
            return f - r;
        }
        let dk = k as f64;
        return ma::<F>(dk, LN2_HI, -(ma::<F>(-dk, LN2_LO, r) - f));
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * ma::<F>(w, ma::<F>(w, LG6, LG4), LG2);
    let t2 = z * ma::<F>(w, ma::<F>(w, ma::<F>(w, LG7, LG5), LG3), LG1);
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 { f - ma::<F>(-s, hfsq + r, hfsq) } else { ma::<F>(dk, LN2_HI, -((hfsq - ma::<F>(s, hfsq + r, dk * LN2_LO)) - f)) }
    } else if k == 0 {
        ma::<F>(-s, f - r, f)
    } else {
        ma::<F>(dk, LN2_HI, -(ma::<F>(s, f - r, -(dk * LN2_LO)) - f))
    }
}

/// `Math.exp` (fdlibm `__ieee754_exp`, with V8's exact `exp(1) == Math.E`).
pub fn exp(x: f64) -> f64 {
    if fma_enabled() { exp_v::<true>(x) } else { exp_v::<false>(x) }
}

pub fn exp_v<const F: bool>(x: f64) -> f64 {
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const E: f64 = 2.718281828459045;
    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const TWO1023: f64 = 8.988465674311579539e307;

    let mut x = x;
    let mut hi_ = 0.0;
    let mut lo_ = 0.0;
    let mut k: i32 = 0;
    let mut hx = hi(x) as u32;
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7fff_ffff;

    if hx >= 0x4086_2E42 {
        if hx >= 0x7ff0_0000 {
            if ((hx & 0xf_ffff) | lo(x)) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return HUGE * HUGE;
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000;
        }
    }

    if hx > 0x3FD6_2E42 {
        if hx < 0x3FF0_A2B2 {
            if x == 1.0 {
                return E;
            }
            hi_ = x - LN2HI[xsb];
            lo_ = LN2LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = ma::<F>(INVLN2, x, HALF[xsb]) as i32;
            let t = k as f64;
            hi_ = ma::<F>(-t, LN2HI[0], x);
            lo_ = t * LN2LO[0];
        }
        x = hi_ - lo_;
    } else if hx < 0x3E30_0000 {
        if HUGE + x > 1.0 {
            return 1.0 + x;
        }
    } else {
        k = 0;
    }

    let t = x * x;
    let twopk = if k >= -1021 {
        from_words(0x3FF0_0000u32.wrapping_add((k as u32) << 20), 0)
    } else {
        from_words(0x3FF0_0000u32.wrapping_add(((k + 1000) as u32) << 20), 0)
    };
    let c = ma::<F>(-t, ma::<F>(t, ma::<F>(t, ma::<F>(t, ma::<F>(t, P5, P4), P3), P2), P1), x);
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo_ - (x * c) / (2.0 - c)) - hi_);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}

fn kernel_cos<const F: bool>(x: f64, y: f64) -> f64 {
    const C1: f64 = 4.16666666666666019037e-02;
    const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05;
    const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09;
    const C6: f64 = -1.13596475577881948265e-11;
    let ix = hi(x) & 0x7fff_ffff;
    if ix < 0x3E40_0000 && (x as i32) == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * ma::<F>(z, ma::<F>(z, ma::<F>(z, ma::<F>(z, ma::<F>(z, C6, C5), C4), C3), C2), C1);
    if ix < 0x3FD3_3333 {
        return 1.0 - ma::<F>(0.5, z, -ma::<F>(z, r, -(x * y)));
    }
    let qx = if ix > 0x3FE9_0000 { 0.28125 } else { from_words((ix - 0x0020_0000) as u32, 0) };
    let iz = ma::<F>(0.5, z, -qx);
    let a = 1.0 - qx;
    a - (iz - ma::<F>(z, r, -(x * y)))
}

fn kernel_sin<const F: bool>(x: f64, y: f64, iy: i32) -> f64 {
    const HALF: f64 = 5.00000000000000000000e-01;
    const S1: f64 = -1.66666666666666324348e-01;
    const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04;
    const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08;
    const S6: f64 = 1.58969099521155010221e-10;
    let ix = hi(x) & 0x7fff_ffff;
    if ix < 0x3E40_0000 && (x as i32) == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = ma::<F>(z, ma::<F>(z, ma::<F>(z, ma::<F>(z, S6, S5), S4), S3), S2);
    if iy == 0 { ma::<F>(v, ma::<F>(z, r, S1), x) } else { x - ma::<F>(-v, S1, ma::<F>(z, ma::<F>(HALF, y, -(v * r)), -y)) }
}

/// fdlibm `__ieee754_rem_pio2` for |x| <= 2^19 * pi/2. Larger arguments return None (the
/// simulator never needs them; `cos` falls back to the platform there).
fn rem_pio2<const F: bool>(x: f64) -> Option<(i32, f64, f64)> {
    const NPIO2_HW: [i32; 32] = [
        0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C,
        0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C,
        0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
    ];
    const HALF: f64 = 5.00000000000000000000e-01;
    const INVPIO2: f64 = 6.36619772367581382433e-01;
    const PIO2_1: f64 = 1.57079632673412561417e+00;
    const PIO2_1T: f64 = 6.07710050650619224932e-11;
    const PIO2_2: f64 = 6.07710050630396597660e-11;
    const PIO2_2T: f64 = 2.02226624879595063154e-21;
    const PIO2_3: f64 = 2.02226624871116645580e-21;
    const PIO2_3T: f64 = 8.47842766036889956997e-32;

    let hx = hi(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3FE9_21FB {
        return Some((0, x, 0.0));
    }
    if ix < 0x4002_D97C {
        if hx > 0 {
            let mut z = x - PIO2_1;
            let (y0, y1);
            if ix != 0x3FF9_21FB {
                y0 = z - PIO2_1T;
                y1 = (z - y0) - PIO2_1T;
            } else {
                z -= PIO2_2;
                y0 = z - PIO2_2T;
                y1 = (z - y0) - PIO2_2T;
            }
            return Some((1, y0, y1));
        }
        let mut z = x + PIO2_1;
        let (y0, y1);
        if ix != 0x3FF9_21FB {
            y0 = z + PIO2_1T;
            y1 = (z - y0) + PIO2_1T;
        } else {
            z += PIO2_2;
            y0 = z + PIO2_2T;
            y1 = (z - y0) + PIO2_2T;
        }
        return Some((-1, y0, y1));
    }
    if ix <= 0x4139_21FB {
        let t = x.abs();
        let n = ma::<F>(t, INVPIO2, HALF) as i32;
        let fn_ = n as f64;
        let mut r = ma::<F>(-fn_, PIO2_1, t);
        let mut w = fn_ * PIO2_1T;
        let mut y0;
        if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
            y0 = r - w;
        } else {
            let j = ix >> 20;
            y0 = r - w;
            let mut i = j - ((hi(y0) >> 20) & 0x7ff);
            if i > 16 {
                let t = r;
                w = fn_ * PIO2_2;
                r = t - w;
                w = ma::<F>(fn_, PIO2_2T, -((t - r) - w));
                y0 = r - w;
                i = j - ((hi(y0) >> 20) & 0x7ff);
                if i > 49 {
                    let t = r;
                    w = fn_ * PIO2_3;
                    r = t - w;
                    w = ma::<F>(fn_, PIO2_3T, -((t - r) - w));
                    y0 = r - w;
                }
            }
        }
        let y1 = (r - y0) - w;
        return Some(if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) });
    }
    None
}

/// `Math.cos` (fdlibm `cos`; bit-exact for |x| <= 2^19 * pi/2, which covers every use here).
pub fn cos(x: f64) -> f64 {
    if fma_enabled() { cos_v::<true>(x) } else { cos_v::<false>(x) }
}

pub fn cos_v<const F: bool>(x: f64) -> f64 {
    let ix = hi(x) & 0x7fff_ffff;
    if ix <= 0x3FE9_21FB {
        return kernel_cos::<F>(x, 0.0);
    }
    if ix >= 0x7ff0_0000 {
        return x - x;
    }
    match rem_pio2::<F>(x) {
        Some((n, y0, y1)) => match n & 3 {
            0 => kernel_cos::<F>(y0, y1),
            1 => -kernel_sin::<F>(y0, y1, 1),
            2 => -kernel_cos::<F>(y0, y1),
            _ => kernel_sin::<F>(y0, y1, 1),
        },
        None => x.cos(),
    }
}

fn scalbn(x: f64, n: i32) -> f64 {
    // exact power-of-two scaling (only reached for subnormal pow results)
    let mut y = x;
    let mut n = n;
    while n > 1023 {
        y *= f64::from_bits(0x7FE0_0000_0000_0000);
        n -= 1023;
    }
    while n < -1022 {
        y *= f64::from_bits(0x0010_0000_0000_0000) * f64::from_bits(0x4340_0000_0000_0000);
        n += 1022 - 53;
    }
    y * f64::from_bits(((0x3ff + n) as u64) << 52)
}

/// `Math.pow` / `**` (ES special cases, then V8's variant of fdlibm `__ieee754_pow`).
pub fn pow(x: f64, y: f64) -> f64 {
    if fma_enabled() { pow_v::<true>(x, y) } else { pow_v::<false>(x, y) }
}

pub fn pow_v<const F: bool>(x: f64, y: f64) -> f64 {
    if y.is_nan() {
        return f64::NAN;
    }
    if y == 0.0 {
        return 1.0;
    }
    if x.is_nan() {
        return f64::NAN;
    }
    if y.is_infinite() && (x == 1.0 || x == -1.0) {
        return f64::NAN;
    }
    fdlibm_pow::<F>(x, y)
}

fn fdlibm_pow<const F: bool>(x: f64, y: f64) -> f64 {
    const BP: [f64; 2] = [1.0, 1.5];
    const DP_H: [f64; 2] = [0.0, 5.84962487220764160156e-01];
    const DP_L: [f64; 2] = [0.0, 1.35003920212974897128e-08];
    const TWO53: f64 = 9007199254740992.0;
    const HUGE: f64 = 1.0e300;
    const TINY: f64 = 1.0e-300;
    const L1: f64 = 5.99999999999994648725e-01;
    const L2: f64 = 4.28571428578550184252e-01;
    const L3: f64 = 3.33333329818377432918e-01;
    const L4: f64 = 2.72728123808534006489e-01;
    const L5: f64 = 2.30660745775561754067e-01;
    const L6: f64 = 2.06975017800338417784e-01;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const LG2: f64 = 6.93147180559945286227e-01;
    const LG2_H: f64 = 6.93147182464599609375e-01;
    const LG2_L: f64 = -1.90465429995776804525e-09;
    const OVT: f64 = 8.0085662595372944372e-17;
    const CP: f64 = 9.61796693925975554329e-01;
    const CP_H: f64 = 9.61796700954437255859e-01;
    const CP_L: f64 = -7.02846165095275826516e-09;
    const IVLN2: f64 = 1.44269504088896338700e+00;
    const IVLN2_H: f64 = 1.44269502162933349609e+00;
    const IVLN2_L: f64 = 1.92596299112661746887e-08;
    const THRD: f64 = 3.3333333333333331e-01;
    const QRTR: f64 = 0.25;

    let hx = hi(x);
    let lx = lo(x);
    let hy = hi(y);
    let ly = lo(y);
    let mut ix = hx & 0x7fff_ffff;
    let iy = hy & 0x7fff_ffff;

    if (iy as u32 | ly) == 0 {
        return 1.0;
    }
    if ix > 0x7ff0_0000 || (ix == 0x7ff0_0000 && lx != 0) || iy > 0x7ff0_0000 || (iy == 0x7ff0_0000 && ly != 0) {
        return (x + 0.0) + (y + 0.0);
    }

    // yisint: 0 not an integer, 1 odd, 2 even (only needed for x < 0)
    let mut yisint = 0;
    if hx < 0 {
        if iy >= 0x4340_0000 {
            yisint = 2;
        } else if iy >= 0x3ff0_0000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = ly >> (52 - k);
                if (j << (52 - k)) == ly {
                    yisint = 2 - (j & 1) as i32;
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    if ly == 0 {
        if iy == 0x7ff0_0000 {
            if ((ix - 0x3ff0_0000) as u32 | lx) == 0 {
                return y - y;
            } else if ix >= 0x3ff0_0000 {
                return if hy >= 0 { y } else { 0.0 };
            } else {
                return if hy < 0 { -y } else { 0.0 };
            }
        }
        if iy == 0x3ff0_0000 {
            return if hy < 0 { 1.0 / x } else { x };
        }
        if hy == 0x4000_0000 {
            return x * x;
        }
        if hy == 0x3fe0_0000 && hx >= 0 {
            return x.sqrt();
        }
    }

    let mut ax = x.abs();
    if lx == 0 && (ix == 0x7ff0_0000 || ix == 0 || ix == 0x3ff0_0000) {
        let mut z = ax;
        if hy < 0 {
            z = 1.0 / z;
        }
        if hx < 0 {
            if ((ix - 0x3ff0_0000) | yisint) == 0 {
                z = (z - z) / (z - z);
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    let mut n: i32 = ((hx as u32) >> 31) as i32 - 1;
    if (n | yisint) == 0 {
        return (x - x) / (x - x);
    }
    let mut s = 1.0;
    if (n | (yisint - 1)) == 0 {
        s = -1.0;
    }

    let t1: f64;
    let t2: f64;
    if iy > 0x41e0_0000 {
        if iy > 0x43f0_0000 {
            if ix <= 0x3fef_ffff {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3ff0_0000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        if ix < 0x3fef_ffff {
            return if hy < 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        if ix > 0x3ff0_0000 {
            return if hy > 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        let t = ax - 1.0;
        let w = (t * t) * ma::<F>(-t, ma::<F>(-t, QRTR, THRD), 0.5);
        let u = IVLN2_H * t;
        let v = ma::<F>(t, IVLN2_L, -(w * IVLN2));
        let tt = set_lo(u + v, 0);
        t1 = tt;
        t2 = v - (tt - u);
    } else {
        n = 0;
        if ix < 0x0010_0000 {
            ax *= TWO53;
            n -= 53;
            ix = hi(ax);
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000f_ffff;
        ix = j | 0x3ff0_0000;
        let k: usize;
        if j <= 0x3988E {
            k = 0;
        } else if j < 0xBB67A {
            k = 1;
        } else {
            k = 0;
            n += 1;
            ix -= 0x0010_0000;
        }
        ax = set_hi(ax, ix as u32);

        let u = ax - BP[k];
        let v = 1.0 / (ax + BP[k]);
        let ss = u * v;
        let s_h = set_lo(ss, 0);
        let t_h = from_words((((ix >> 1) | 0x2000_0000) + 0x0008_0000 + ((k as i32) << 18)) as u32, 0);
        let t_l = ax - (t_h - BP[k]);
        let s_l = v * ma::<F>(-s_h, t_l, ma::<F>(-s_h, t_h, u));
        let mut s2 = ss * ss;
        let mut r = s2 * s2 * ma::<F>(s2, ma::<F>(s2, ma::<F>(s2, ma::<F>(s2, ma::<F>(s2, L6, L5), L4), L3), L2), L1);
        r = ma::<F>(s_l, s_h + ss, r);
        s2 = s_h * s_h;
        let t_h = set_lo(3.0 + s2 + r, 0);
        let t_l = r - ((t_h - 3.0) - s2);
        let u = s_h * t_h;
        let v = ma::<F>(s_l, t_h, t_l * ss);
        let p_h = set_lo(u + v, 0);
        let p_l = v - (p_h - u);
        let z_h = CP_H * p_h;
        let z_l = ma::<F>(CP_L, p_h, p_l * CP) + DP_L[k];
        let t = n as f64;
        let tt = set_lo(((z_h + z_l) + DP_H[k]) + t, 0);
        t1 = tt;
        t2 = z_l - (((tt - t) - DP_H[k]) - z_h);
    }

    let y1 = set_lo(y, 0);
    let p_l = ma::<F>(y - y1, t1, y * t2);
    let mut p_h = y1 * t1;
    let z = p_l + p_h;
    let j = hi(z);
    let i = lo(z) as i32;
    if j >= 0x4090_0000 {
        if ((j - 0x4090_0000) | i) != 0 {
            return s * HUGE * HUGE;
        }
        if p_l + OVT > z - p_h {
            return s * HUGE * HUGE;
        }
    } else if (j & 0x7fff_ffff) >= 0x4090_cc00 {
        if ((j as u32).wrapping_sub(0xc090_cc00) as i32 | i) != 0 {
            return s * TINY * TINY;
        }
        if p_l <= z - p_h {
            return s * TINY * TINY;
        }
    }

    let i = j & 0x7fff_ffff;
    let mut k = (i >> 20) - 0x3ff;
    let mut n: i32 = 0;
    if i > 0x3fe0_0000 {
        n = j + (0x0010_0000 >> (k + 1));
        k = ((n & 0x7fff_ffff) >> 20) - 0x3ff;
        let t = from_words((n & !(0x000f_ffff >> k)) as u32, 0);
        n = ((n & 0x000f_ffff) | 0x0010_0000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = set_lo(p_l + p_h, 0);
    let u = t * LG2_H;
    let v = ma::<F>(p_l - (t - p_h), LG2, t * LG2_L);
    let mut z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = ma::<F>(-t, ma::<F>(t, ma::<F>(t, ma::<F>(t, ma::<F>(t, P5, P4), P3), P2), P1), z);
    // V8 deviates from fdlibm here: (z*t1) / ((t1 - 2) - (w + z*w)), not (z*t1)/(t1 - 2) - (w + z*w)
    let r = (z * t1) / ((t1 - 2.0) - ma::<F>(z, w, w));
    z = 1.0 - (r - z);
    let mut j = hi(z);
    j = j.wrapping_add(n << 20);
    if (j >> 20) <= 0 {
        z = scalbn(z, n);
    } else {
        z = set_hi(z, j as u32);
    }
    s * z
}

/// `Math.round`: the nearest integer, ties toward +infinity (V8: ceil, then step back).
pub fn round(x: f64) -> f64 {
    let c = x.ceil();
    if c - 0.5 > x { c - 1.0 } else { c }
}

/// `Number(x.toFixed(6))` for 0 <= x < 9e9 (what the controller reads back from the mock's
/// `completed_work` strings). toFixed rounds the exact binary value half-up; computed exactly
/// with integers, then n / 1e6 is the correctly rounded parse of the 6-decimal string.
pub fn fixed6(x: f64) -> f64 {
    if !(x >= 0.0) || x >= 9.0e9 {
        return format!("{x:.6}").parse().unwrap_or(x);
    }
    if x == 0.0 {
        return 0.0;
    }
    let bits = x.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i32;
    let (mant, e) = if exp == 0 { (bits & ((1u64 << 52) - 1), -1074) } else { ((bits & ((1u64 << 52) - 1)) | (1u64 << 52), exp - 1075) };
    // x = mant * 2^e; n = round_half_up(x * 10^6)
    let scaled = mant as u128 * 1_000_000u128;
    let n: u128 = if e >= 0 {
        scaled << e
    } else {
        let sh = (-e) as u32;
        if sh >= 128 {
            0
        } else {
            let q = scaled >> sh;
            let rem = scaled - (q << sh);
            let half = 1u128 << (sh - 1);
            if rem >= half { q + 1 } else { q }
        }
    };
    n as f64 / 1e6
}

/// `Date.parse(new Date(ms).toISOString())`: JS dates hold whole milliseconds (TimeClip truncates).
pub fn ms_trunc(ms: f64) -> f64 {
    ms.trunc()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spot_values() {
        assert_eq!(log(1.0), 0.0);
        assert_eq!(exp(0.0), 1.0);
        assert_eq!(exp(1.0), std::f64::consts::E);
        assert_eq!(cos(0.0), 1.0);
        assert_eq!(pow(0.94, 0.0), 1.0);
        assert_eq!(pow(0.94, 1.0), 0.94);
        assert_eq!(pow(0.94, 2.0), 0.94 * 0.94);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(fixed6(0.0078125), 0.007813); // exact tie rounds up like toFixed
        assert_eq!(fixed6(1.5), 1.5);
        assert_eq!(fixed6(123.4567894), 123.456789);
    }
}
