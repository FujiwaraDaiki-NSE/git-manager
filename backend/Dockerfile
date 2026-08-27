FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# git 本体と ssh クライアント。fetch を SSH リモートに対して行うため
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN uv pip install --system --no-cache -r requirements.txt

COPY app ./app

# ホストの uid で動かすため、書き込み先を明示しておく
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
