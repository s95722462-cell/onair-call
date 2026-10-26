# 앱이 그린 QR 이미지를 OpenCV 로 다시 읽기: python -I tests/qr_decode.py a.png b.png ...  → JSON {파일: 읽은 글자}
import json, sys
import cv2

out = {}
det = cv2.QRCodeDetector()
for f in sys.argv[1:]:
    img = cv2.imread(f)
    txt = ""
    if img is not None:
        txt, _, _ = det.detectAndDecode(img)   # 원래 크기 그대로 (확대·축소 없이)
    out[f] = txt
print(json.dumps(out, ensure_ascii=False))
