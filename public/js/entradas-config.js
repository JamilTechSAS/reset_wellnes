/* =====================================================================
   RESET · CONFIGURACIÓN DE ENTRADAS
   Este es el único archivo que necesitas editar para vender entradas.
   ===================================================================== */
window.RESET_ENTRADAS = {

  /* FASE DE VENTA
     "preventa" → se vende la preventa; la general aparece como "próximamente".
     "general"  → la preventa aparece como "agotada" y se vende la general. */
  fase: "preventa",

  /* LINKS DE PAGO (Wompi, Mercado Pago…): pega cada link entre las comillas.
     Si un link está vacío, el botón abre WhatsApp con un mensaje listo. */
  links: {
    preventa: "",
    duo: "",
    general: ""
  },

  whatsapp: "573133340844"
};
