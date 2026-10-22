# [DRIFT] siso main.star: upstream добавил ключ в step_config и проверку перед правкой — строка ложится в своё if
load("@builtin//struct.star", "module")
load("./config.star", "config")

def init(ctx):
    host = {
        "linux": "linux",
        "mac": "mac",
    }[ctx.host]
    step_config = {
        "platforms": {},
        "input_deps": {},
        "rules": [],
        "gn_logs_data": {},
    }
    if config.get(ctx, "debug"):
        step_config["debug"] = True
    if config.get(ctx, "remote"):
        step_config["remote"] = True
        step_config["brave_remote"] = True
    return module(
        "config",
        step_config = step_config,
    )
