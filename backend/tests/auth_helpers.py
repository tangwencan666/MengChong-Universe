PASSWORD = "Local-Only-Safe!2026"


def csrf(client):
    response = client.get("/api/v1/auth/csrf")
    assert response.status_code == 200, response.text
    return {"X-CSRF-Token": response.json()["csrf_token"]}


def post(client, endpoint, payload=None):
    return client.post(f"/api/v1/auth/{endpoint}", json=payload, headers=csrf(client))


def register(client, email="first@example.com", password=PASSWORD, name="小未同学"):
    return post(client, "register", {"email": email, "password": password, "display_name": name})


def login(client, email="first@example.com", password=PASSWORD):
    return post(client, "login", {"email": email, "password": password})
