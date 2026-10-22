# [OBLIGATION] за собственной скобкой словаря нет строки health — берётся скобка вложенного словаря: обязательство первое, но не единственное
ROUTES = {
    "users": {"get": list_users, "post": create_user},
    "health": ping,
}
