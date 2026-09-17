FROM python:3.11-slim
WORKDIR /app
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt
COPY main.py .
EXPOSE 8090
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
