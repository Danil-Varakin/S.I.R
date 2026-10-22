# [OBLIGATION] вставка перед закрывашкой словаря маршрутов: берётся его собственная скобка, а не скобка вложенного словаря, хотя та тоже закрыватель
ROUTES = {
    "users": {"get": list_users, "post": create_user},
    "health": ping,
    "metrics": metrics,
}

FALLBACK = {"*": not_found}
