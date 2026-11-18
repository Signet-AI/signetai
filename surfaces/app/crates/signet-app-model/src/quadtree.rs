pub(crate) const NONE: u32 = u32::MAX;

#[derive(Clone, Copy)]
pub(crate) struct Quad {
    pub children: [u32; 4],
    pub data: u32,
    pub next: u32,
    pub x: f64,
    pub y: f64,
    pub value: f64,
    pub r: f64,
}

impl Quad {
    fn internal() -> Self {
        Self {
            children: [NONE; 4],
            data: NONE,
            next: NONE,
            x: 0.0,
            y: 0.0,
            value: 0.0,
            r: 0.0,
        }
    }

    fn leaf(data: u32) -> Self {
        Self {
            data,
            ..Self::internal()
        }
    }

    pub fn is_leaf(&self) -> bool {
        self.data != NONE
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Visit {
    pub quad: u32,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

pub(crate) struct Quadtree {
    pub quads: Vec<Quad>,
    pub root: u32,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    stack: Vec<Visit>,
    order: Vec<u32>,
}

impl Quadtree {
    pub fn new() -> Self {
        Self {
            quads: Vec::new(),
            root: NONE,
            x0: f64::NAN,
            y0: f64::NAN,
            x1: f64::NAN,
            y1: f64::NAN,
            stack: Vec::new(),
            order: Vec::new(),
        }
    }

    pub fn build(&mut self, xs: &[f64], ys: &[f64]) {
        self.quads.clear();
        self.root = NONE;
        self.x0 = f64::NAN;
        self.y0 = f64::NAN;
        self.x1 = f64::NAN;
        self.y1 = f64::NAN;
        let (mut x0, mut y0, mut x1, mut y1) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for (&x, &y) in xs.iter().zip(ys) {
            if x.is_nan() || y.is_nan() {
                continue;
            }
            if x < x0 {
                x0 = x;
            }
            if x > x1 {
                x1 = x;
            }
            if y < y0 {
                y0 = y;
            }
            if y > y1 {
                y1 = y;
            }
        }
        if x0 > x1 || y0 > y1 {
            return;
        }
        self.cover(x0, y0);
        self.cover(x1, y1);
        for index in 0..xs.len() {
            self.add(xs, ys, index as u32);
        }
    }

    fn cover(&mut self, x: f64, y: f64) {
        if x.is_nan() || y.is_nan() {
            return;
        }
        if self.x0.is_nan() {
            self.x0 = x.floor();
            self.x1 = self.x0 + 1.0;
            self.y0 = y.floor();
            self.y1 = self.y0 + 1.0;
            return;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (self.x0, self.y0, self.x1, self.y1);
        let mut z = x1 - x0;
        if z == 0.0 || z.is_nan() {
            z = 1.0;
        }
        while x0 > x || x >= x1 || y0 > y || y >= y1 {
            let corner = (usize::from(y < y0) << 1) | usize::from(x < x0);
            z *= 2.0;
            match corner {
                0 => {
                    x1 = x0 + z;
                    y1 = y0 + z;
                }
                1 => {
                    x0 = x1 - z;
                    y1 = y0 + z;
                }
                2 => {
                    x1 = x0 + z;
                    y0 = y1 - z;
                }
                _ => {
                    x0 = x1 - z;
                    y0 = y1 - z;
                }
            }
        }
        self.x0 = x0;
        self.y0 = y0;
        self.x1 = x1;
        self.y1 = y1;
    }

    fn push(&mut self, quad: Quad) -> u32 {
        self.quads.push(quad);
        (self.quads.len() - 1) as u32
    }

    fn add(&mut self, xs: &[f64], ys: &[f64], data: u32) {
        let x = xs[data as usize];
        let y = ys[data as usize];
        if x.is_nan() || y.is_nan() {
            return;
        }
        let leaf = self.push(Quad::leaf(data));
        if self.root == NONE {
            self.root = leaf;
            return;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (self.x0, self.y0, self.x1, self.y1);
        let mut node = self.root;
        let mut parent = NONE;
        let mut slot = 0;
        while !self.quads[node as usize].is_leaf() {
            let xm = (x0 + x1) / 2.0;
            let right = x >= xm;
            if right {
                x0 = xm;
            } else {
                x1 = xm;
            }
            let ym = (y0 + y1) / 2.0;
            let bottom = y >= ym;
            if bottom {
                y0 = ym;
            } else {
                y1 = ym;
            }
            parent = node;
            slot = (usize::from(bottom) << 1) | usize::from(right);
            node = self.quads[parent as usize].children[slot];
            if node == NONE {
                self.quads[parent as usize].children[slot] = leaf;
                return;
            }
        }
        let existing = self.quads[node as usize].data as usize;
        let xp = xs[existing];
        let yp = ys[existing];
        if x == xp && y == yp {
            self.quads[leaf as usize].next = node;
            if parent == NONE {
                self.root = leaf;
            } else {
                self.quads[parent as usize].children[slot] = leaf;
            }
            return;
        }
        loop {
            let split = self.push(Quad::internal());
            if parent == NONE {
                self.root = split;
            } else {
                self.quads[parent as usize].children[slot] = split;
            }
            parent = split;
            let xm = (x0 + x1) / 2.0;
            let right = x >= xm;
            if right {
                x0 = xm;
            } else {
                x1 = xm;
            }
            let ym = (y0 + y1) / 2.0;
            let bottom = y >= ym;
            if bottom {
                y0 = ym;
            } else {
                y1 = ym;
            }
            slot = (usize::from(bottom) << 1) | usize::from(right);
            let other = (usize::from(yp >= ym) << 1) | usize::from(xp >= xm);
            if slot != other {
                let quad = &mut self.quads[parent as usize];
                quad.children[other] = node;
                quad.children[slot] = leaf;
                return;
            }
        }
    }

    pub fn post_order(&mut self, mut visit: impl FnMut(&mut [Quad], u32)) {
        self.order.clear();
        if self.root == NONE {
            return;
        }
        self.order.push(self.root);
        let mut at = 0;
        while at < self.order.len() {
            let quad = self.quads[self.order[at] as usize];
            if !quad.is_leaf() {
                for child in quad.children {
                    if child != NONE {
                        self.order.push(child);
                    }
                }
            }
            at += 1;
        }
        for &quad in self.order.iter().rev() {
            visit(&mut self.quads, quad);
        }
    }

    pub fn visit(&mut self, mut visit: impl FnMut(&[Quad], Visit) -> bool) {
        let mut stack = std::mem::take(&mut self.stack);
        stack.clear();
        if self.root != NONE {
            stack.push(Visit {
                quad: self.root,
                x0: self.x0,
                y0: self.y0,
                x1: self.x1,
                y1: self.y1,
            });
        }
        while let Some(at) = stack.pop() {
            if visit(&self.quads, at) {
                continue;
            }
            let quad = &self.quads[at.quad as usize];
            if quad.is_leaf() {
                continue;
            }
            let xm = (at.x0 + at.x1) / 2.0;
            let ym = (at.y0 + at.y1) / 2.0;
            let [c0, c1, c2, c3] = quad.children;
            if c3 != NONE {
                stack.push(Visit {
                    quad: c3,
                    x0: xm,
                    y0: ym,
                    x1: at.x1,
                    y1: at.y1,
                });
            }
            if c2 != NONE {
                stack.push(Visit {
                    quad: c2,
                    x0: at.x0,
                    y0: ym,
                    x1: xm,
                    y1: at.y1,
                });
            }
            if c1 != NONE {
                stack.push(Visit {
                    quad: c1,
                    x0: xm,
                    y0: at.y0,
                    x1: at.x1,
                    y1: ym,
                });
            }
            if c0 != NONE {
                stack.push(Visit {
                    quad: c0,
                    x0: at.x0,
                    y0: at.y0,
                    x1: xm,
                    y1: ym,
                });
            }
        }
        self.stack = stack;
    }
}
