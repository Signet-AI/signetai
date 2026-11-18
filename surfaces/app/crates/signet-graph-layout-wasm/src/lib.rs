use signet_app_model::layout::ForceLayout;
use std::cell::RefCell;

thread_local! {
    static LAYOUTS: RefCell<Vec<Option<ForceLayout>>> = const { RefCell::new(Vec::new()) };
}

fn with<T>(handle: u32, default: T, run: impl FnOnce(&mut ForceLayout) -> T) -> T {
    LAYOUTS.with_borrow_mut(|layouts| match layouts.get_mut(handle as usize) {
        Some(Some(layout)) => run(layout),
        _ => default,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_create(nodes: u32, links: u32) -> u32 {
    LAYOUTS.with_borrow_mut(|layouts| {
        let layout = Some(ForceLayout::new(nodes as usize, links as usize));
        match layouts.iter().position(Option::is_none) {
            Some(free) => {
                layouts[free] = layout;
                free as u32
            }
            None => {
                layouts.push(layout);
                (layouts.len() - 1) as u32
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_buffer(handle: u32, field: u32) -> u32 {
    with(handle, 0, |layout| match field {
        0 => layout.x.as_mut_ptr() as u32,
        1 => layout.y.as_mut_ptr() as u32,
        2 => layout.vx.as_mut_ptr() as u32,
        3 => layout.vy.as_mut_ptr() as u32,
        4 => layout.charge.as_mut_ptr() as u32,
        5 => layout.radius.as_mut_ptr() as u32,
        6 => layout.link_source.as_mut_ptr() as u32,
        7 => layout.link_target.as_mut_ptr() as u32,
        8 => layout.link_bias.as_mut_ptr() as u32,
        9 => layout.link_strength.as_mut_ptr() as u32,
        10 => layout.link_distance.as_mut_ptr() as u32,
        _ => 0,
    })
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn layout_configure(
    handle: u32,
    theta2: f64,
    distance_min2: f64,
    distance_max2: f64,
    collide_strength: f64,
    center_x: f64,
    center_y: f64,
    center_strength: f64,
) -> u32 {
    with(handle, 0, |layout| {
        let settings = &mut layout.settings;
        settings.theta2 = theta2;
        settings.distance_min2 = distance_min2;
        settings.distance_max2 = distance_max2;
        settings.collide_strength = collide_strength;
        settings.center_x = center_x;
        settings.center_y = center_y;
        settings.center_strength = center_strength;
        u32::from(layout.valid())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_apply(handle: u32, alpha: f64) -> u32 {
    with(handle, 0, |layout| {
        layout.apply(alpha);
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_drop(handle: u32) {
    LAYOUTS.with_borrow_mut(|layouts| {
        if let Some(slot) = layouts.get_mut(handle as usize) {
            *slot = None;
        }
    });
}
