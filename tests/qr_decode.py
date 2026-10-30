# 앱이 그린 QR 이미지를 OpenCV 로 다시 읽기: python -I tests/qr_decode.py a.png b.png ...  → JSON {파일: 읽은 글자}
import json, sys
import cv2
import numpy as np

out = {}
det = cv2.QRCodeDetector()
for f in sys.argv[1:]:
    try:   # cv2.imread 는 윈도우 한글 경로(문서)를 못 엶 → 바이트로 읽어 디코드
        img = cv2.imdecode(np.fromfile(f, dtype=np.uint8), cv2.IMREAD_COLOR)
    except OSError:
        img = None
    txt = ""
    if img is not None:
        txt, _, _ = det.detectAndDecode(img)   # 원래 크기 그대로 (확대·축소 없이)
    out[f] = txt
print(json.dumps(out))   # ASCII 로 (콘솔 인코딩 무관)
