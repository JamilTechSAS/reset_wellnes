/**
 * Legal content — client supplied (Phase 6C)
 *
 * SOURCE: `terminos-y-condiciones.html` from the client handover
 * (`Reset-web-para-programador-…zip`), which contains three documents in tabs:
 * participants' terms (with waiver, risk assumption and image rights), the refund policy and
 * the personal-data processing policy (Ley 1581 de 2012).
 *
 * Rules applied here:
 *   * The text is reproduced as the client supplied it. It has NOT been rewritten, shortened
 *     or reinterpreted — legal wording is the client's to approve, not ours to edit.
 *   * Fields the client left as `(pendiente)` stay unresolved and are rendered through the
 *     `{{token}}` mechanism below, so they are impossible to miss before launch.
 *   * Where the supplied text is internally inconsistent it is published unchanged and listed
 *     in `LEGAL_REVIEW_NOTES` for client/legal sign-off.
 */

import type { LegalTabId } from "../types/content.ts";

export type LegalSection = {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
};

export type LegalDocument = {
  readonly id: LegalTabId;
  readonly tabLabel: string;
  readonly title: string;
  readonly brandLine: string;
  readonly sections: readonly LegalSection[];
};

/**
 * Unresolved client fields. Each key is the token used inside the text below; the value is the
 * human label rendered in place of it.
 */
export const LEGAL_PENDING_FIELDS = {
  webDomain: "dominio del sitio web",
  legalEntityName: "razón social o nombre del responsable del tratamiento",
  legalEntityNit: "NIT o cédula",
  privacyPolicyDate: "fecha de publicación de la política",
} as const;

export type LegalPendingFieldKey = keyof typeof LEGAL_PENDING_FIELDS;

/**
 * Internal review notes. These are NOT rendered in the dialog: they exist so that the open
 * points travel with the content and cannot be lost between phases.
 */
export const LEGAL_REVIEW_NOTES: readonly string[] = [
  "Reembolsos: el texto del cliente combina un derecho de cancelación de 7 días posteriores a la compra con una exclusión para compras dentro de las 48 horas previas al evento y con exclusiones para entradas compradas con códigos de descuento o promociones. Se publica tal cual, pendiente de revisión legal (Ley 1480, derecho de retracto).",
  "Encargados del tratamiento: el texto del cliente nombra FormSubmit como servicio de envío de formularios. Esta plataforma no usa FormSubmit: los pagos se procesan con Wompi, los datos se almacenan en Supabase y los correos se envían por el proveedor de correo configurado. La lista de encargados debe actualizarse con aprobación legal antes de publicar.",
  "Datos del responsable: la razón social, el NIT/cédula y la fecha de publicación siguen sin confirmar; el documento no puede considerarse definitivo hasta que el cliente los entregue.",
  "Autorización de comunicaciones: el cliente no entregó un texto separado de autorización para comunicaciones de eventos futuros. En la compra se usan dos consentimientos diferenciados (tratamiento de datos y eventos futuros), acordes con el modelo de datos del backend.",
  "El texto se refiere a la actividad 'sueroterapia (tratamientos intravenosos)' como parte de las actividades del evento; la organización debe confirmar que cuenta con personal habilitado y con las autorizaciones sanitarias correspondientes.",
];

const CONTACT_LINE = "Reset Wellness Club. Correo electrónico: reset.wellness@gmail.com";

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    id: "participantes",
    tabLabel: "Para participantes",
    title: "Términos y condiciones",
    brandLine: "Reset Wellness Club",
    sections: [
      {
        id: "bienvenida",
        heading: "¡Bienvenidos a Reset Wellness Club!",
        paragraphs: [
          "Reset es más que un evento; es un encuentro seleccionado para hombres y mujeres que abrazan el movimiento, la atención plena y la comunidad. Un espacio donde el bienestar se une a la conexión social de una manera refrescante e intencional.",
          "Estos términos y condiciones describen las reglas y regulaciones para el uso del sitio web de Reset, ubicado en {{webDomain}}.",
          "Al acceder a este sitio web, usted acepta estos términos y condiciones. Debe aceptarlos antes de comprar cualquier entrada o participar en el evento. Si no acepta todos los términos y condiciones aquí establecidos, no continúe utilizando Reset.",
        ],
      },
      {
        id: "aceptacion",
        heading: "Aceptación obligatoria al finalizar la compra",
        paragraphs: [
          "Al marcar la casilla de aceptación obligatoria al finalizar la compra, usted reconoce haber leído, comprendido y aceptado estos Términos y Condiciones, incluyendo la Exención de Responsabilidad, la Asunción de Riesgos y el Acuerdo de Indemnización. Su participación en el evento está sujeta a la aceptación de estos términos.",
        ],
      },
      {
        id: "cookies",
        heading: "Cookies",
        paragraphs: [
          "Este sitio web utiliza cookies para personalizar tu experiencia en línea. Al acceder a Reset, aceptas el uso de las cookies necesarias. Podemos utilizar cookies para recopilar, almacenar y rastrear información con fines estadísticos o de marketing. Tienes la opción de aceptar o rechazar las cookies opcionales.",
        ],
      },
      {
        id: "licencia",
        heading: "Licencia",
        paragraphs: [
          "Salvo que se indique lo contrario, Reset y/o sus licenciantes poseen los derechos de propiedad intelectual de todo el material de Reset. Todos los derechos de propiedad intelectual están reservados. Puede acceder a este material desde Reset para su uso personal, sujeto a las restricciones establecidas en estos términos y condiciones.",
          "No debes:",
        ],
        bullets: [
          "Copiar o republicar material de Reset.",
          "Vender, alquilar o sublicenciar material de Reset.",
          "Reproducir, duplicar o copiar material de Reset.",
          "Redistribuir el contenido de Reset.",
        ],
      },
      {
        id: "enlaces",
        heading: "Enlaces a nuestro contenido",
        paragraphs: [
          "Algunas organizaciones pueden enlazar a nuestro sitio web sin aprobación previa, incluyendo agencias gubernamentales, motores de búsqueda y medios de comunicación. Nos reservamos el derecho de considerar y aprobar las solicitudes de enlace de otras organizaciones.",
        ],
      },
      {
        id: "responsabilidad-contenido",
        heading: "Responsabilidad del contenido",
        paragraphs: [
          "No nos hacemos responsables del contenido que aparezca en su sitio web. No se permite incluir enlaces en ningún sitio web que puedan considerarse difamatorios, obscenos o delictivos.",
        ],
      },
      {
        id: "waiver",
        heading: "Acuerdo de exención de responsabilidad, asunción de riesgos e indemnización",
        paragraphs: [
          "Aviso importante: este Acuerdo de Exención de Responsabilidad, Asunción de Riesgos e Indemnización (el «Acuerdo») contiene una renuncia a su derecho a demandar, una liberación de toda reclamación y otras disposiciones que afectan sus derechos legales. Léalo atentamente.",
          "Exención de responsabilidad: a cambio de que se me permita participar en el evento que se identifica a continuación, yo, en mi nombre y en el de mis herederos, representantes y sucesores, libero y renuncio a cualquier reclamación contra las Partes Liberadas, incluyendo, entre otros, a Reset y a todos los patrocinadores, anunciantes y proveedores de servicios involucrados en el evento.",
        ],
      },
      {
        id: "actividades",
        heading: "Descripción del evento y las actividades",
        paragraphs: [
          "Nombre del evento: Reset Wellness Club.",
          "Actividades del evento: incluyen, entre otras, clases de pilates, yoga y spinning; inmersión en hielo; quiropráctica; sueroterapia (tratamientos intravenosos); bronceo; consumo de alimentos y bebidas; activaciones de marcas y otras actividades de bienestar.",
        ],
      },
      {
        id: "riesgos",
        heading: "Asunción de riesgos",
        paragraphs: [
          "Reconozco y acepto que la participación en el Evento es voluntaria e implica riesgos inherentes, incluidos, entre otros:",
        ],
        bullets: [
          "Muerte, parálisis, ataques cardíacos, derrame cerebral, ahogamiento, hipotermia/hipertermia, congelación.",
          "Agotamiento o golpe de calor, conmociones cerebrales, lesiones oculares, articulares o óseas.",
          "Riesgos asociados con el consumo de alimentos, quemaduras leves/graves, exacerbación de afecciones preexistentes.",
          "Exposición a la COVID-19 u otras enfermedades contagiosas.",
        ],
      },
      {
        id: "indemnizacion",
        heading: "Indemnización y exención de responsabilidad",
        paragraphs: [
          "Al marcar la casilla de consentimiento o firmar electrónicamente este Acuerdo, confirmo que he evaluado los riesgos y los asumo voluntariamente. Acepto indemnizar, defender y eximir de responsabilidad a las Partes Exoneradas de cualquier reclamación derivada de mi participación en el Evento.",
        ],
      },
      {
        id: "imagen",
        heading: "Autorización de uso de imagen",
        paragraphs: [
          "Otorgo a Reset y a sus afiliados, socios y proveedores que participan en el evento el derecho y permiso irrevocable para usar mi nombre, imagen, semejanza y voz, incluyendo cualquier fotografía, video o grabación tomada de mí durante el evento, con fines promocionales, publicitarios o editoriales en cualquier medio, conocido actualmente o que se desarrolle en el futuro, en todo el mundo y a perpetuidad, sin compensación alguna.",
          "Entiendo que esto incluye imágenes o grabaciones en las que yo o cualquier representante de un proveedor aparezcamos sosteniendo o interactuando con productos de Reset Wellness Club u otros proveedores participantes. Reconozco y acepto que Reset Wellness Club o cualquier proveedor participante en el evento podrá utilizar estas imágenes con fines legítimos de marketing y publicidad.",
          "Asimismo, acepto que no responsabilizaré a Reset Wellness Club, sus filiales ni a otros proveedores participantes, ni interpondré ninguna demanda legal, por el uso de dichos materiales, siempre que se utilicen de buena fe y de conformidad con el propósito promocional del evento.",
        ],
      },
      {
        id: "transferencias",
        heading: "Cancelaciones, reembolsos y transferencias",
        paragraphs: [
          "Las cancelaciones, los reembolsos y la transferencia de entradas se rigen por nuestra Política de reembolsos, que hace parte integral de estos Términos y Condiciones.",
        ],
      },
      {
        id: "cierre",
        heading: "Divisibilidad, ley aplicable y firma electrónica",
        paragraphs: [
          "Divisibilidad: si alguna parte de este Acuerdo se considera inválida, las demás disposiciones seguirán en pleno vigor y efecto.",
          "Ley aplicable: el presente Acuerdo se rige por las leyes de la República de Colombia.",
          "Consentimiento para la firma electrónica: estoy de acuerdo en que la firma electrónica de este Acuerdo tiene el mismo efecto que una firma física.",
          "Reconocimiento de comprensión: he leído este Acuerdo en su totalidad, comprendo plenamente sus términos y confirmo que lo firmo libre y voluntariamente.",
          `Para obtener más información, póngase en contacto con: ${CONTACT_LINE}`,
        ],
      },
    ],
  },

  {
    id: "reembolsos",
    tabLabel: "Política de reembolsos",
    title: "Política de reembolsos",
    brandLine: "Reset Wellness Club",
    sections: [
      {
        id: "cancelacion",
        heading: "Cancelación de boletos y reembolsos",
        paragraphs: [
          "Usted tiene derecho a cancelar la compra de su entrada dentro de los 7 días posteriores a la fecha de compra. Esto aplica para las entradas de preventa, general y Comparte esta experiencia.",
          "El plazo para cancelar el pedido es de 7 días a partir de la fecha de compra. Para ejercer su derecho de cancelación, debe comunicarnos su decisión mediante una declaración inequívoca.",
          "Puede comunicarnos su decisión por correo electrónico a reset.wellness@gmail.com.",
          "Procesaremos los reembolsos en un plazo máximo de 7 días a partir de la fecha en que recibamos su solicitud de cancelación. Los reembolsos se realizarán mediante el método de pago original utilizado para la compra y no se le cobrará ninguna comisión.",
        ],
      },
      {
        id: "condiciones",
        heading: "Condiciones para el reembolso de entradas",
        paragraphs: [],
        bullets: [
          "La solicitud debe realizarse dentro de los 7 días posteriores a la fecha de compra.",
          "La entrada no debe haber sido utilizada para acceder al evento.",
          "Las entradas adquiridas con códigos de descuento o promociones especiales no son reembolsables.",
          "No se realizarán reembolsos por las entradas compradas con menos de 48 horas de antelación al evento.",
        ],
      },
      {
        id: "no-reembolsables",
        heading: "Entradas no reembolsables",
        paragraphs: ["Las siguientes entradas no son reembolsables:"],
        bullets: [
          "Entradas adquiridas a través de vendedores externos o plataformas de reventa.",
          "Entradas para eventos que ya han tenido lugar.",
          "Entradas adquiridas mediante promociones no reembolsables.",
          "Entradas transferidas a otra persona.",
        ],
      },
      {
        id: "cancelacion-evento",
        heading: "Cancelaciones y aplazamientos de eventos",
        paragraphs: [
          "Si el organizador cancela Reset, se reembolsará el importe íntegro a todos los poseedores de entradas.",
          "Si el evento se pospone, su entrada seguirá siendo válida para la nueva fecha. Si no puede asistir en la nueva fecha, puede solicitar un reembolso dentro de los 7 días posteriores al anuncio del cambio de fecha.",
        ],
      },
      {
        id: "regalo",
        heading: "Entradas de regalo",
        paragraphs: [
          "Si la entrada se compró como regalo y se envió directamente al destinatario, cualquier reembolso se emitirá como crédito para eventos que podrá utilizarse en futuros eventos de Reset Wellness Club.",
          "Si tiene alguna pregunta sobre nuestra Política de Devoluciones y Reembolsos, póngase en contacto con nosotros en reset.wellness@gmail.com.",
        ],
      },
    ],
  },

  {
    id: "privacidad",
    tabLabel: "Política de privacidad",
    title: "Política de privacidad y tratamiento de datos personales",
    brandLine: "Reset Wellness Club",
    sections: [
      {
        id: "intro",
        heading: "Introducción",
        paragraphs: [
          "En Reset Wellness Club cuidamos sus datos personales y nos comprometemos a garantizar su confidencialidad y seguridad. Esta Política de Tratamiento de Datos Personales explica qué información recopilamos, para qué la usamos y cómo puede ejercer sus derechos, de acuerdo con la Ley 1581 de 2012 y sus decretos reglamentarios.",
        ],
      },
      {
        id: "responsable",
        heading: "Responsable del tratamiento",
        paragraphs: [
          "Nombre o razón social: {{legalEntityName}}",
          "NIT o cédula: {{legalEntityNit}}",
          "Ciudad: Montería, Córdoba, Colombia",
          "Correo: reset.wellness@gmail.com",
          "Teléfono: 313 334 0844",
        ],
      },
      {
        id: "recopilamos",
        heading: "Información que recopilamos",
        paragraphs: [
          "Recopilamos los datos que usted nos entrega directamente al unirse a nuestra comunidad, comprar una entrada o escribirnos desde un formulario: nombre, apellidos, correo electrónico, número de teléfono, documento de identidad, ciudad y, en el caso de las marcas, el nombre de la marca o su página web.",
          "Cuando visita el sitio web, también podemos recopilar automáticamente cierta información sobre su dispositivo, como el navegador, la dirección IP, la zona horaria, las páginas que visita y cómo llegó al sitio. Usamos esta información de forma agregada, para generar estadísticas de uso y detectar posibles abusos.",
          "Los pagos se procesan a través de pasarelas de pago externas. Reset Wellness Club no almacena los datos de sus tarjetas ni de sus cuentas bancarias.",
        ],
      },
      {
        id: "finalidades",
        heading: "Finalidades del tratamiento",
        paragraphs: ["Usamos sus datos personales para:"],
        bullets: [
          "Gestionar la compra de entradas, el acceso al evento y la asignación de grupos y horarios.",
          "Enviarle información sobre eventos, novedades y beneficios de Reset y de nuestras marcas aliadas.",
          "Responder solicitudes, preguntas y propuestas de colaboración de marcas.",
          "Gestionar cancelaciones y reembolsos.",
          "Generar estadísticas sobre el uso del sitio web y mejorar nuestras experiencias.",
          "Cumplir obligaciones legales.",
        ],
      },
      {
        id: "autorizacion",
        heading: "Autorización",
        paragraphs: [
          "Al enviar sus datos a través de nuestros formularios o al comprar una entrada, usted autoriza de manera previa, expresa e informada a Reset Wellness Club para tratarlos según las finalidades descritas en esta política. Puede optar por no entregarnos sus datos, pero en ese caso es posible que no pueda acceder a algunas funciones, como recibir nuestras novedades o comprar entradas.",
        ],
      },
      {
        id: "derechos",
        heading: "Sus derechos",
        paragraphs: ["Como titular de los datos, usted tiene derecho a:"],
        bullets: [
          "Conocer, actualizar y rectificar sus datos personales.",
          "Solicitar prueba de la autorización otorgada.",
          "Ser informado sobre el uso que se le ha dado a sus datos.",
          "Presentar quejas ante la Superintendencia de Industria y Comercio por infracciones a la ley.",
          "Revocar la autorización y/o solicitar la supresión de sus datos cuando no se respeten los principios, derechos y garantías legales.",
          "Acceder de forma gratuita a sus datos personales.",
        ],
      },
      {
        id: "ejercer",
        heading: "Cómo ejercer sus derechos",
        paragraphs: [
          "Puede enviar sus consultas o reclamos al correo reset.wellness@gmail.com, indicando su nombre, su documento de identidad, la descripción de su solicitud y un medio de contacto.",
          "Las consultas se responderán en un plazo máximo de diez (10) días hábiles, prorrogable por cinco (5) días hábiles más. Los reclamos se atenderán en un plazo máximo de quince (15) días hábiles, prorrogable por ocho (8) días hábiles más. En ambos casos le informaremos los motivos de cualquier demora.",
        ],
      },
      {
        id: "encargados",
        heading: "Encargados y proveedores",
        paragraphs: [
          "Para operar el sitio web y la venta de entradas usamos proveedores externos, como el servicio de alojamiento del sitio web, la pasarela de pagos y el servicio de envío de formularios (FormSubmit). Algunos de estos proveedores pueden almacenar información en servidores ubicados fuera de Colombia. Solo compartimos con ellos los datos necesarios para prestar el servicio.",
        ],
      },
      {
        id: "enlaces-privacidad",
        heading: "Enlaces a otros sitios web",
        paragraphs: [
          "Nuestro sitio web puede contener enlaces a otros sitios web que no son de nuestra propiedad ni están bajo nuestro control. No nos hacemos responsables de dichos sitios web ni de sus prácticas de privacidad. Le recomendamos leer las políticas de privacidad de cada sitio que visite.",
        ],
      },
      {
        id: "seguridad",
        heading: "Seguridad de la información",
        paragraphs: [
          "Mantenemos medidas de seguridad administrativas, técnicas y físicas razonables para proteger los datos personales bajo nuestro control contra el acceso, uso, modificación y divulgación no autorizados. Sin embargo, no se puede garantizar la seguridad de ninguna transmisión de datos a través de Internet o redes inalámbricas.",
          "Aviso legal: revelaremos la información que recopilemos si así lo exige la ley, por ejemplo, para cumplir con una orden judicial o atender un requerimiento de una autoridad competente.",
        ],
      },
      {
        id: "vigencia",
        heading: "Vigencia",
        paragraphs: [
          "Esta política rige a partir del {{privacyPolicyDate}}. Sus datos se conservarán mientras sean necesarios para las finalidades descritas o mientras exista una obligación legal. Cualquier cambio será publicado en este sitio web.",
          "Si tiene preguntas sobre esta política, escríbanos a reset.wellness@gmail.com.",
        ],
      },
    ],
  },
];

/** The tabs shown in the legal dialog, in order. */
export const LEGAL_TAB_IDS: readonly LegalTabId[] = LEGAL_DOCUMENTS.map((document) => document.id);
