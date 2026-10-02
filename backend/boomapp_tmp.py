from app.main import create_app
app = create_app()
@app.get("/boom")
async def boom():
    raise RuntimeError("secret")
