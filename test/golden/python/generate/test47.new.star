# [STAR] siso main.star (Starlark): правило в функции init — синтаксис Python
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
    }
    if config.get(ctx, "remote"):
        step_config["remote"] = True
        step_config["brave_remote"] = True
    return module(
        "config",
        step_config = step_config,
    )
