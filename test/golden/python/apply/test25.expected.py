# [ESCAPE] незакрытая скобка упорядочивает, не запирает: в словаре маршрутов нет admin, шаблон уходит в ADMIN — выход из словаря разрешён
ROUTES = {
    "health": ping,
}

ADMIN = {
    "admin": {"get": dashboard, "post": reset},
}
