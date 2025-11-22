fn split_yyyymmdd(yyyymmdd: u32) -> (u32, u32, u32) {
    let year = yyyymmdd / 10000;
    let md = yyyymmdd % 10000;
    let month = md / 100;
    let day = md % 100;
    (year, month, day)
}

fn is_adult(birth: u32, today: u32) -> bool {
    let (by, bm, bd) = split_yyyymmdd(birth);
    let (ty, tm, td) = split_yyyymmdd(today);
    let dy = ty - by;
    let gt18 = dy > 18;
    let eq18 = dy == 18;
    let month_ok = if tm > bm { true } else { if tm == bm { td >= bd } else { false } };
    if gt18 { true } else { if eq18 { month_ok } else { false } }
}

fn main(birth: u32, today: u32) -> pub bool {
    is_adult(birth, today)
}