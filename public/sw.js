// service worker minimo: riceve le notifiche push e le mostra, apre/porta in primo piano
// il sito quando la notifica viene toccata. Nessuna cache offline: non serve per questo sito.

self.addEventListener("push", (event) => {
  let dati = { title: "🟡 assistente oro", body: "nuovo segnale" };
  try {
    if (event.data) dati = event.data.json();
  } catch {
    // corpo non json: tiene il messaggio di default
  }
  event.waitUntil(
    self.registration.showNotification(dati.title, {
      body: dati.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: dati.data || {},
      tag: "oro-segnale",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((elenco) => {
      for (const client of elenco) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
