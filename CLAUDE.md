## MUHIM API saboqlari

**Sana/epoch konvertatsiyasi HECH QACHON qo'lda (kalendar hisoblab) bajarilmasin.**
Doim bash orqali amalga oshirilsin, masalan:

```bash
node -e "console.log(new Date(EPOCH_MS).toLocaleString('en-US', {timeZone:'Asia/Tashkent'}))"
```

Bu qoida barcha sana bilan bog'liq tekshiruv va diagnostika ishlariga tegishli.
