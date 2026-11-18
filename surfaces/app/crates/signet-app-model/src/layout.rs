use crate::quadtree::{NONE, Quadtree};

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = (1_664_525 * self.0 + 1_013_904_223) % 4_294_967_296;
        self.0 as f64 / 4_294_967_296.0
    }

    fn jiggle(&mut self) -> f64 {
        (self.next() - 0.5) * 1e-6
    }
}

pub struct Settings {
    pub theta2: f64,
    pub distance_min2: f64,
    pub distance_max2: f64,
    pub collide_strength: f64,
    pub center_x: f64,
    pub center_y: f64,
    pub center_strength: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theta2: 0.81,
            distance_min2: 1.0,
            distance_max2: f64::INFINITY,
            collide_strength: 1.0,
            center_x: 0.0,
            center_y: 0.0,
            center_strength: 0.1,
        }
    }
}

pub struct ForceLayout {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub charge: Vec<f64>,
    pub radius: Vec<f64>,
    pub link_source: Vec<u32>,
    pub link_target: Vec<u32>,
    pub link_bias: Vec<f64>,
    pub link_strength: Vec<f64>,
    pub link_distance: Vec<f64>,
    pub settings: Settings,
    random: Lcg,
    tree: Quadtree,
    shifted_x: Vec<f64>,
    shifted_y: Vec<f64>,
}

impl ForceLayout {
    pub fn new(nodes: usize, links: usize) -> Self {
        Self {
            x: vec![0.0; nodes],
            y: vec![0.0; nodes],
            vx: vec![0.0; nodes],
            vy: vec![0.0; nodes],
            charge: vec![0.0; nodes],
            radius: vec![0.0; nodes],
            link_source: vec![0; links],
            link_target: vec![0; links],
            link_bias: vec![0.0; links],
            link_strength: vec![0.0; links],
            link_distance: vec![0.0; links],
            settings: Settings::default(),
            random: Lcg(1),
            tree: Quadtree::new(),
            shifted_x: vec![0.0; nodes],
            shifted_y: vec![0.0; nodes],
        }
    }

    pub fn valid(&self) -> bool {
        let nodes = self.x.len();
        self.link_source
            .iter()
            .chain(&self.link_target)
            .all(|&index| (index as usize) < nodes)
    }

    pub fn apply(&mut self, alpha: f64) {
        self.link(alpha);
        self.many_body(alpha);
        self.collide();
        self.center(alpha);
    }

    fn link(&mut self, alpha: f64) {
        let Self {
            x,
            y,
            vx,
            vy,
            random,
            ..
        } = self;
        for link in 0..self.link_source.len() {
            let source = self.link_source[link] as usize;
            let target = self.link_target[link] as usize;
            let mut dx = x[target] + vx[target] - x[source] - vx[source];
            if dx == 0.0 || dx.is_nan() {
                dx = random.jiggle();
            }
            let mut dy = y[target] + vy[target] - y[source] - vy[source];
            if dy == 0.0 || dy.is_nan() {
                dy = random.jiggle();
            }
            let mut l = (dx * dx + dy * dy).sqrt();
            l = (l - self.link_distance[link]) / l * alpha * self.link_strength[link];
            dx *= l;
            dy *= l;
            let bias = self.link_bias[link];
            vx[target] -= dx * bias;
            vy[target] -= dy * bias;
            let bias = 1.0 - bias;
            vx[source] += dx * bias;
            vy[source] += dy * bias;
        }
    }

    fn many_body(&mut self, alpha: f64) {
        let Self {
            x,
            y,
            vx,
            vy,
            charge,
            settings,
            random,
            tree,
            ..
        } = self;
        tree.build(x, y);
        tree.post_order(|quads, at| {
            let quad = quads[at as usize];
            if quad.is_leaf() {
                let mut strength = 0.0;
                let mut leaf = at;
                while leaf != NONE {
                    strength += charge[quads[leaf as usize].data as usize];
                    leaf = quads[leaf as usize].next;
                }
                let head = &mut quads[at as usize];
                head.x = x[quad.data as usize];
                head.y = y[quad.data as usize];
                head.value = strength;
                return;
            }
            let (mut strength, mut weight, mut cx, mut cy) = (0.0, 0.0, 0.0, 0.0);
            for child in quad.children {
                if child == NONE {
                    continue;
                }
                let child = quads[child as usize];
                let c = child.value.abs();
                if c != 0.0 && !c.is_nan() {
                    strength += child.value;
                    weight += c;
                    cx += c * child.x;
                    cy += c * child.y;
                }
            }
            let quad = &mut quads[at as usize];
            quad.x = cx / weight;
            quad.y = cy / weight;
            quad.value = strength;
        });
        let theta2 = settings.theta2;
        let min2 = settings.distance_min2;
        let max2 = settings.distance_max2;
        for node in 0..x.len() {
            let (nx, ny) = (x[node], y[node]);
            tree.visit(|quads, at| {
                let quad = &quads[at.quad as usize];
                if quad.value == 0.0 || quad.value.is_nan() {
                    return true;
                }
                let mut dx = quad.x - nx;
                let mut dy = quad.y - ny;
                let w = at.x1 - at.x0;
                let mut l = dx * dx + dy * dy;
                if w * w / theta2 < l {
                    if l < max2 {
                        if dx == 0.0 {
                            dx = random.jiggle();
                            l += dx * dx;
                        }
                        if dy == 0.0 {
                            dy = random.jiggle();
                            l += dy * dy;
                        }
                        if l < min2 {
                            l = (min2 * l).sqrt();
                        }
                        vx[node] += dx * quad.value * alpha / l;
                        vy[node] += dy * quad.value * alpha / l;
                    }
                    return true;
                }
                if !quad.is_leaf() || l >= max2 {
                    return false;
                }
                if quad.data as usize != node || quad.next != NONE {
                    if dx == 0.0 {
                        dx = random.jiggle();
                        l += dx * dx;
                    }
                    if dy == 0.0 {
                        dy = random.jiggle();
                        l += dy * dy;
                    }
                    if l < min2 {
                        l = (min2 * l).sqrt();
                    }
                }
                let mut leaf = at.quad;
                while leaf != NONE {
                    let data = quads[leaf as usize].data as usize;
                    if data != node {
                        let w = charge[data] * alpha / l;
                        vx[node] += dx * w;
                        vy[node] += dy * w;
                    }
                    leaf = quads[leaf as usize].next;
                }
                false
            });
        }
    }

    fn collide(&mut self) {
        let Self {
            x,
            y,
            vx,
            vy,
            radius,
            settings,
            random,
            tree,
            shifted_x,
            shifted_y,
            ..
        } = self;
        for node in 0..x.len() {
            shifted_x[node] = x[node] + vx[node];
            shifted_y[node] = y[node] + vy[node];
        }
        tree.build(shifted_x, shifted_y);
        tree.post_order(|quads, at| {
            let quad = quads[at as usize];
            let r = if quad.is_leaf() {
                radius[quad.data as usize]
            } else {
                let mut r = 0.0;
                for child in quad.children {
                    if child != NONE && quads[child as usize].r > r {
                        r = quads[child as usize].r;
                    }
                }
                r
            };
            quads[at as usize].r = r;
        });
        let strength = settings.collide_strength;
        for node in 0..x.len() {
            let ri = radius[node];
            let ri2 = ri * ri;
            let xi = x[node] + vx[node];
            let yi = y[node] + vy[node];
            tree.visit(|quads, at| {
                let quad = &quads[at.quad as usize];
                let rj = quad.r;
                let r = ri + rj;
                if quad.is_leaf() {
                    let data = quad.data as usize;
                    if data > node {
                        let mut dx = xi - x[data] - vx[data];
                        let mut dy = yi - y[data] - vy[data];
                        let mut l = dx * dx + dy * dy;
                        if l < r * r {
                            if dx == 0.0 {
                                dx = random.jiggle();
                                l += dx * dx;
                            }
                            if dy == 0.0 {
                                dy = random.jiggle();
                                l += dy * dy;
                            }
                            let root = l.sqrt();
                            let l = (r - root) / root * strength;
                            dx *= l;
                            dy *= l;
                            let rj2 = rj * rj;
                            let share = rj2 / (ri2 + rj2);
                            vx[node] += dx * share;
                            vy[node] += dy * share;
                            let share = 1.0 - share;
                            vx[data] -= dx * share;
                            vy[data] -= dy * share;
                        }
                    }
                    return false;
                }
                at.x0 > xi + r || at.x1 < xi - r || at.y0 > yi + r || at.y1 < yi - r
            });
        }
    }

    fn center(&mut self, alpha: f64) {
        let Settings {
            center_x,
            center_y,
            center_strength,
            ..
        } = self.settings;
        for node in 0..self.x.len() {
            self.vx[node] += (center_x - self.x[node]) * center_strength * alpha;
        }
        for node in 0..self.y.len() {
            self.vy[node] += (center_y - self.y[node]) * center_strength * alpha;
        }
    }
}
