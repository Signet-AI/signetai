use std::f64::consts::PI;

pub type Act = usize;

#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        self.state
    }

    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn gauss(&mut self, mean: f64, std: f64) -> f64 {
        let u1 = self.next_f64().max(1e-10);
        let u2 = self.next_f64();
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos();
        mean + std * z
    }
}

#[derive(Clone, Debug)]
pub struct Param {
    pub data: Vec<f64>,
    pub grad: Vec<f64>,
    pub rows: usize,
    pub cols: usize,
}

impl Param {
    pub fn matrix(rng: &mut Rng, rows: usize, cols: usize, std: f64) -> Self {
        let n = rows * cols;
        let data = (0..n).map(|_| rng.gauss(0.0, std)).collect();
        Self {
            data,
            grad: vec![0.0; n],
            rows,
            cols,
        }
    }

    pub fn zero_grad(&mut self) {
        self.grad.fill(0.0);
    }
}

#[derive(Clone, Debug)]
enum Op {
    Embed {
        param: usize,
        row: usize,
        out: Act,
    },
    VecAdd {
        a: Act,
        b: Act,
        out: Act,
    },
    MatVec {
        param: usize,
        x: Act,
        out: Act,
    },
    Dot {
        a: Act,
        b: Act,
        out: Act,
    },
    Scale {
        x: Act,
        factor: f64,
        out: Act,
    },
    Relu {
        x: Act,
        out: Act,
    },
    Sigmoid {
        x: Act,
        out: Act,
    },
    Softmax {
        x: Act,
        out: Act,
    },
    LayerNorm {
        x: Act,
        out: Act,
        inv_std: f64,
    },
    MeanPool {
        inputs: Vec<Act>,
        out: Act,
    },
    FeatureConcat {
        inputs: Vec<Act>,
        out: Act,
    },
    ListwiseLoss {
        pred_logits: Act,
        out: Act,
        temperature: f64,
        p_pred: Vec<f64>,
        p_true: Vec<f64>,
    },
}

#[derive(Debug)]
pub struct Tape {
    params: Vec<Param>,
    act_data: Vec<Vec<f64>>,
    act_grad: Vec<Vec<f64>>,
    ops: Vec<Op>,
}

impl Default for Tape {
    fn default() -> Self {
        Self::new()
    }
}

impl Tape {
    pub fn new() -> Self {
        Self {
            params: Vec::new(),
            act_data: Vec::new(),
            act_grad: Vec::new(),
            ops: Vec::new(),
        }
    }

    pub fn add_param(&mut self, p: Param) -> usize {
        let idx = self.params.len();
        self.params.push(p);
        idx
    }

    pub fn params(&self) -> &[Param] {
        &self.params
    }

    pub fn params_mut(&mut self) -> &mut [Param] {
        &mut self.params
    }

    pub fn reset(&mut self) {
        self.act_data.clear();
        self.act_grad.clear();
        self.ops.clear();
        for p in &mut self.params {
            p.zero_grad();
        }
    }

    pub fn alloc(&mut self, size: usize) -> Act {
        let idx = self.act_data.len();
        self.act_data.push(vec![0.0; size]);
        self.act_grad.push(vec![0.0; size]);
        idx
    }

    pub fn constant(&mut self, values: Vec<f64>) -> Act {
        let out = self.alloc(values.len());
        self.act_data[out] = values;
        out
    }

    pub fn value(&self, act: Act) -> &[f64] {
        &self.act_data[act]
    }

    pub fn scalar(&self, act: Act) -> f64 {
        self.act_data[act][0]
    }

    fn assert_same_len(&self, a: Act, b: Act) {
        assert_eq!(
            self.act_data[a].len(),
            self.act_data[b].len(),
            "shape mismatch: {} != {}",
            self.act_data[a].len(),
            self.act_data[b].len()
        );
    }

    pub fn vec_add(&mut self, a: Act, b: Act) -> Act {
        self.assert_same_len(a, b);
        let n = self.act_data[a].len();
        let out = self.alloc(n);
        for i in 0..n {
            self.act_data[out][i] = self.act_data[a][i] + self.act_data[b][i];
        }
        self.ops.push(Op::VecAdd { a, b, out });
        out
    }

    pub fn embed_row(&mut self, param: usize, row: usize) -> Act {
        let cols = self.params[param].cols;
        assert!(
            row < self.params[param].rows,
            "row {} out of bounds for embedding rows {}",
            row,
            self.params[param].rows
        );
        let out = self.alloc(cols);
        let start = row * cols;
        self.act_data[out].copy_from_slice(&self.params[param].data[start..start + cols]);
        self.ops.push(Op::Embed { param, row, out });
        out
    }

    pub fn matvec(&mut self, param: usize, x: Act) -> Act {
        let rows = self.params[param].rows;
        let cols = self.params[param].cols;
        assert_eq!(
            self.act_data[x].len(),
            cols,
            "matvec input width mismatch: {} != {}",
            self.act_data[x].len(),
            cols
        );
        let out = self.alloc(rows);
        for r in 0..rows {
            let row_start = r * cols;
            let mut sum = 0.0;
            for c in 0..cols {
                sum += self.params[param].data[row_start + c] * self.act_data[x][c];
            }
            self.act_data[out][r] = sum;
        }
        self.ops.push(Op::MatVec { param, x, out });
        out
    }

    pub fn dot(&mut self, a: Act, b: Act) -> Act {
        self.assert_same_len(a, b);
        let n = self.act_data[a].len();
        let out = self.alloc(1);
        let mut sum = 0.0;
        for i in 0..n {
            sum += self.act_data[a][i] * self.act_data[b][i];
        }
        self.act_data[out][0] = sum;
        self.ops.push(Op::Dot { a, b, out });
        out
    }

    pub fn scale(&mut self, x: Act, factor: f64) -> Act {
        let n = self.act_data[x].len();
        let out = self.alloc(n);
        for i in 0..n {
            self.act_data[out][i] = self.act_data[x][i] * factor;
        }
        self.ops.push(Op::Scale { x, factor, out });
        out
    }

    pub fn relu(&mut self, x: Act) -> Act {
        let n = self.act_data[x].len();
        let out = self.alloc(n);
        for i in 0..n {
            self.act_data[out][i] = self.act_data[x][i].max(0.0);
        }
        self.ops.push(Op::Relu { x, out });
        out
    }

    pub fn sigmoid(&mut self, x: Act) -> Act {
        let n = self.act_data[x].len();
        let out = self.alloc(n);
        for i in 0..n {
            self.act_data[out][i] = 1.0 / (1.0 + (-self.act_data[x][i]).exp());
        }
        self.ops.push(Op::Sigmoid { x, out });
        out
    }

    pub fn softmax(&mut self, x: Act) -> Act {
        let out = self.alloc(self.act_data[x].len());
        let probs = softmax_with_temperature(&self.act_data[x], 1.0);
        self.act_data[out].copy_from_slice(&probs);
        self.ops.push(Op::Softmax { x, out });
        out
    }

    pub fn layer_norm(&mut self, x: Act) -> Act {
        let n = self.act_data[x].len();
        assert!(n > 0, "layer_norm requires non-empty input");
        let out = self.alloc(n);

        let mean = self.act_data[x].iter().sum::<f64>() / n as f64;
        let variance = self.act_data[x]
            .iter()
            .map(|v| {
                let d = *v - mean;
                d * d
            })
            .sum::<f64>()
            / n as f64;
        let inv_std = 1.0 / (variance + 1e-5).sqrt();

        for i in 0..n {
            self.act_data[out][i] = (self.act_data[x][i] - mean) * inv_std;
        }
        self.ops.push(Op::LayerNorm { x, out, inv_std });
        out
    }

    pub fn mean_pool(&mut self, inputs: &[Act]) -> Act {
        assert!(!inputs.is_empty(), "mean_pool requires at least one input");
        let width = self.act_data[inputs[0]].len();
        for input in inputs {
            assert_eq!(
                self.act_data[*input].len(),
                width,
                "mean_pool shape mismatch"
            );
        }
        let out = self.alloc(width);
        let inv = 1.0 / inputs.len() as f64;
        for input in inputs {
            for i in 0..width {
                self.act_data[out][i] += self.act_data[*input][i] * inv;
            }
        }
        self.ops.push(Op::MeanPool {
            inputs: inputs.to_vec(),
            out,
        });
        out
    }

    pub fn feature_concat(&mut self, inputs: &[Act]) -> Act {
        assert!(
            !inputs.is_empty(),
            "feature_concat requires at least one input"
        );
        let total = inputs.iter().map(|a| self.act_data[*a].len()).sum();
        let out = self.alloc(total);
        let mut offset = 0;
        for input in inputs {
            let len = self.act_data[*input].len();
            for i in 0..len {
                self.act_data[out][offset + i] = self.act_data[*input][i];
            }
            offset += len;
        }
        self.ops.push(Op::FeatureConcat {
            inputs: inputs.to_vec(),
            out,
        });
        out
    }

    pub fn listwise_loss(&mut self, pred_logits: Act, true_logits: Act, temperature: f64) -> Act {
        self.assert_same_len(pred_logits, true_logits);
        assert!(temperature > 0.0, "temperature must be > 0");

        let p_pred = softmax_with_temperature(&self.act_data[pred_logits], temperature);
        let p_true = softmax_with_temperature(&self.act_data[true_logits], temperature);

        let out = self.alloc(1);
        let eps = 1e-9;
        let mut kl = 0.0;
        for i in 0..p_pred.len() {
            kl += p_true[i] * ((p_true[i] + eps).ln() - (p_pred[i] + eps).ln());
        }
        self.act_data[out][0] = kl;
        self.ops.push(Op::ListwiseLoss {
            pred_logits,
            out,
            temperature,
            p_pred,
            p_true,
        });
        out
    }

    pub fn backward(&mut self, loss: Act) {
        assert_eq!(self.act_data[loss].len(), 1, "loss must be scalar");
        self.act_grad[loss][0] = 1.0;

        let ops = std::mem::take(&mut self.ops);
        for op in ops.into_iter().rev() {
            match op {
                Op::Embed { param, row, out } => {
                    let cols = self.params[param].cols;
                    let start = row * cols;
                    for c in 0..cols {
                        self.params[param].grad[start + c] += self.act_grad[out][c];
                    }
                }
                Op::VecAdd { a, b, out } => {
                    for i in 0..self.act_data[out].len() {
                        let g = self.act_grad[out][i];
                        self.act_grad[a][i] += g;
                        self.act_grad[b][i] += g;
                    }
                }
                Op::MatVec { param, x, out } => {
                    let rows = self.params[param].rows;
                    let cols = self.params[param].cols;
                    for r in 0..rows {
                        let go = self.act_grad[out][r];
                        let row_start = r * cols;
                        for c in 0..cols {
                            self.params[param].grad[row_start + c] += go * self.act_data[x][c];
                            self.act_grad[x][c] += go * self.params[param].data[row_start + c];
                        }
                    }
                }
                Op::Dot { a, b, out } => {
                    let g = self.act_grad[out][0];
                    for i in 0..self.act_data[a].len() {
                        self.act_grad[a][i] += g * self.act_data[b][i];
                        self.act_grad[b][i] += g * self.act_data[a][i];
                    }
                }
                Op::Scale { x, factor, out } => {
                    for i in 0..self.act_data[out].len() {
                        self.act_grad[x][i] += self.act_grad[out][i] * factor;
                    }
                }
                Op::Relu { x, out } => {
                    for i in 0..self.act_data[out].len() {
                        if self.act_data[x][i] > 0.0 {
                            self.act_grad[x][i] += self.act_grad[out][i];
                        }
                    }
                }
                Op::Sigmoid { x, out } => {
                    for i in 0..self.act_data[out].len() {
                        let y = self.act_data[out][i];
                        self.act_grad[x][i] += self.act_grad[out][i] * y * (1.0 - y);
                    }
                }
                Op::Softmax { x, out } => {
                    let y = self.act_data[out].clone();
                    let gy = self.act_grad[out].clone();
                    let dot: f64 = y.iter().zip(&gy).map(|(a, b)| a * b).sum();
                    for i in 0..y.len() {
                        self.act_grad[x][i] += y[i] * (gy[i] - dot);
                    }
                }
                Op::LayerNorm { x, out, inv_std } => {
                    let n = self.act_data[out].len() as f64;
                    let y = self.act_data[out].clone();
                    let gy = self.act_grad[out].clone();
                    let sum_gy: f64 = gy.iter().sum();
                    let sum_gy_y: f64 = gy.iter().zip(&y).map(|(g, yi)| g * yi).sum();
                    for j in 0..y.len() {
                        let centered = gy[j] - (sum_gy / n) - y[j] * (sum_gy_y / n);
                        self.act_grad[x][j] += inv_std * centered;
                    }
                }
                Op::MeanPool { inputs, out } => {
                    let inv = 1.0 / inputs.len() as f64;
                    for input in inputs {
                        for i in 0..self.act_data[out].len() {
                            self.act_grad[input][i] += self.act_grad[out][i] * inv;
                        }
                    }
                }
                Op::FeatureConcat { inputs, out } => {
                    let mut offset = 0;
                    for input in inputs {
                        let len = self.act_data[input].len();
                        let end = offset + len;
                        for i in 0..len {
                            self.act_grad[input][i] += self.act_grad[out][offset + i];
                        }
                        offset = end;
                    }
                }
                Op::ListwiseLoss {
                    pred_logits,
                    out,
                    temperature,
                    p_pred,
                    p_true,
                } => {
                    let upstream = self.act_grad[out][0];
                    for i in 0..p_pred.len() {
                        self.act_grad[pred_logits][i] +=
                            upstream * (p_pred[i] - p_true[i]) / temperature;
                    }
                }
            }
        }
    }

    pub fn grad(&self, act: Act) -> &[f64] {
        &self.act_grad[act]
    }
}

fn softmax_with_temperature(values: &[f64], temperature: f64) -> Vec<f64> {
    let max = values
        .iter()
        .map(|v| *v / temperature)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut exps = Vec::with_capacity(values.len());
    let mut sum = 0.0;
    for value in values {
        let e = (*value / temperature - max).exp();
        exps.push(e);
        sum += e;
    }
    for value in &mut exps {
        *value /= sum;
    }
    exps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{} != {} (tol {})", a, b, tol);
    }

    #[test]
    fn sigmoid_backward_matches_reference() {
        let mut tape = Tape::new();
        let x = tape.constant(vec![0.2, -1.0]);
        let y = tape.sigmoid(x);
        let ones = tape.constant(vec![1.0, 1.0]);
        let sum = tape.dot(y, ones);
        let loss = tape.scale(sum, 0.5);
        tape.backward(loss);

        let yv = tape.value(y).to_vec();
        let grad = tape.grad(x).to_vec();
        approx_eq(grad[0], yv[0] * (1.0 - yv[0]) * 0.5, 1e-8);
        approx_eq(grad[1], yv[1] * (1.0 - yv[1]) * 0.5, 1e-8);
    }

    #[test]
    fn mean_pool_splits_gradient_evenly() {
        let mut tape = Tape::new();
        let a = tape.constant(vec![2.0, 4.0]);
        let b = tape.constant(vec![6.0, 8.0]);
        let pooled = tape.mean_pool(&[a, b]);
        let ones = tape.constant(vec![1.0, 1.0]);
        let sum = tape.dot(pooled, ones);
        let scalar = tape.scale(sum, 0.5);

        tape.backward(scalar);
        let ga = tape.grad(a).to_vec();
        let gb = tape.grad(b).to_vec();
        approx_eq(ga[0], 0.25, 1e-8);
        approx_eq(ga[1], 0.25, 1e-8);
        approx_eq(gb[0], 0.25, 1e-8);
        approx_eq(gb[1], 0.25, 1e-8);
    }

    #[test]
    fn feature_concat_routes_gradient_to_each_slice() {
        let mut tape = Tape::new();
        let a = tape.constant(vec![1.0, 2.0]);
        let b = tape.constant(vec![3.0]);
        let c = tape.feature_concat(&[a, b]);
        let ones = tape.constant(vec![1.0, 1.0, 1.0]);
        let sum = tape.dot(c, ones);
        let loss = tape.scale(sum, 1.0 / 3.0);
        tape.backward(loss);

        let ga = tape.grad(a).to_vec();
        let gb = tape.grad(b).to_vec();
        approx_eq(ga[0], 1.0 / 3.0, 1e-8);
        approx_eq(ga[1], 1.0 / 3.0, 1e-8);
        approx_eq(gb[0], 1.0 / 3.0, 1e-8);
    }

    #[test]
    fn listwise_loss_pushes_larger_gradient_to_worse_rank() {
        let mut tape = Tape::new();
        let pred = tape.constant(vec![0.1, 0.9]);
        let target = tape.constant(vec![1.0, 0.0]);
        let loss = tape.listwise_loss(pred, target, 0.5);
        let loss_value = tape.scalar(loss);
        tape.backward(loss);

        let grad = tape.grad(pred).to_vec();
        assert!(loss_value.is_finite());
        assert!(grad[0] < 0.0);
        assert!(grad[1] > 0.0);
    }

    #[test]
    fn matvec_backprop_updates_weight_grads() {
        let mut tape = Tape::new();
        let mut rng = Rng::new(7);
        let p = tape.add_param(Param::matrix(&mut rng, 1, 2, 0.1));
        let x = tape.constant(vec![1.0, 3.0]);
        let y = tape.matvec(p, x);
        tape.backward(y);

        let grad = tape.params()[p].grad.clone();
        approx_eq(grad[0], 1.0, 1e-8);
        approx_eq(grad[1], 3.0, 1e-8);
    }

    #[test]
    fn layer_norm_produces_zero_mean_unit_variance() {
        let mut tape = Tape::new();
        let x = tape.constant(vec![1.0, 3.0, 5.0, 7.0]);
        let y = tape.layer_norm(x);
        let values = tape.value(y);
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let variance = values
            .iter()
            .map(|v| {
                let d = *v - mean;
                d * d
            })
            .sum::<f64>()
            / values.len() as f64;
        assert!(mean.abs() < 1e-8);
        assert!((variance - 1.0).abs() < 1e-3);
    }
}
