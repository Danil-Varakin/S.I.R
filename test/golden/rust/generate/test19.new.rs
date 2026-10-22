// [MACRORULES] macro_rules!: правила в скобках, $x:expr и => — не структура языка
macro_rules! check {
    ($cond:expr) => {
        if !$cond {
            panic!("check failed: {}", stringify!($cond));
        }
    };
    ($cond:expr, $msg:literal) => {
        if !$cond {
            log::error!("{}", $msg);
            panic!($msg);
        }
    };
}

fn run(x: i32) {
    check!(x > 0);
    check!(x < 100, "too big");
}
