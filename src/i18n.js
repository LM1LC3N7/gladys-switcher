// -----------------------------------------------------------------------------
// Runtime texts (English and French): the status of the integration, the
// transport badges of the devices, the answers of the button and the command
// errors. No text repeats a value a user typed.
// -----------------------------------------------------------------------------

export const both = (en, fr) => ({ en, fr });
export const join = (...texts) =>
  both(texts.map((t) => t.en).join(' '), texts.map((t) => t.fr).join(' '));

/** A thrown text: both languages in one message (the integration does not know the user's). */
export const message = (text) => `${text.fr} / ${text.en}`;

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const list = (names) => names.join(', ');

/** The status of the configuration screen. */
export const T = {
  starting: both('Starting…', 'Démarrage…'),
  configUnread: (wait) =>
    both(
      `The configuration of Gladys could not be read; next try in ${wait.en} (stops kept in /data still leave).`,
      `La configuration de Gladys n'a pas pu être lue ; nouvel essai dans ${wait.fr} (les arrêts gardés dans /data partent quand même).`,
    ),
  noDevice: both(
    'No Switcher device found yet: open the Discovery tab and scan (the devices announce themselves on the local network).',
    "Aucun appareil Switcher trouvé pour l'instant : ouvrez l'onglet Découverte et lancez une recherche (les appareils s'annoncent sur le réseau local).",
  ),
  scanUnavailable: both(
    'The network scan of Gladys is not available (Gladys 5.1 or later with network discovery is needed): no device can be found.',
    "La recherche réseau de Gladys n'est pas disponible (Gladys 5.1 ou plus récent, avec la découverte réseau) : aucun appareil ne peut être trouvé.",
  ),
  scanFailed: both(
    'The last network scan failed; the devices already known are still read.',
    'La dernière recherche réseau a échoué ; les appareils déjà connus sont toujours lus.',
  ),
  summary: (read, total) =>
    both(
      `${read} of ${total} Switcher device(s) read.`,
      `${read} appareil(s) Switcher lu(s) sur ${total}.`,
    ),
  failing: (names) => both(`Unreachable: ${list(names)}.`, `Injoignable(s) : ${list(names)}.`),
  unconfirmed: (names) =>
    both(
      `Not seen by a scan for 15 min (address not confirmed, only stops are sent): ${list(names)}.`,
      `Pas vu par une recherche depuis 15 min (adresse non confirmée, seuls les arrêts partent) : ${list(names)}.`,
    ),
  tokenModels: (names) =>
    both(
      `Found but not supported (these models need the token of the Switcher account): ${list(names)}.`,
      `Trouvé(s) mais non pris en charge (ces modèles exigent le jeton du compte Switcher) : ${list(names)}.`,
    ),
  stopsWaiting: (names) =>
    both(
      `Stop kept, not sent yet (device unreachable): ${list(names)}.`,
      `Arrêt gardé, pas encore envoyé (appareil injoignable) : ${list(names)}.`,
    ),
  stopsUnconfirmed: (names) =>
    both(
      `Stop sent, not seen applied yet: ${list(names)}.`,
      `Arrêt envoyé, pas encore vu appliqué : ${list(names)}.`,
    ),
  stopsContradicted: (names) =>
    both(
      `Stop sent 3 times, the device still reads on (kept until it reads off or is switched on from Gladys): ${list(names)}.`,
      `Arrêt envoyé 3 fois, l'appareil se lit toujours en marche (gardé jusqu'à une lecture éteinte ou une mise en marche depuis Gladys) : ${list(names)}.`,
    ),
  dataUnreadable: both(
    'The /data file cannot be read: it is read again every 10 s, nothing is written there meanwhile.',
    'Le fichier de /data est illisible : il est relu toutes les 10 s, rien n’y est écrit en attendant.',
  ),
  dataUnwritable: both(
    'The /data file cannot be written: commands other than stops are refused.',
    'Le fichier de /data ne peut pas être écrit : les commandes autres que les arrêts sont refusées.',
  ),
  test: {
    found: (count, names) =>
      both(
        `Scan done: ${count} device(s) heard${names.length ? ` (${list(names)})` : ''}.`,
        `Recherche faite : ${count} appareil(s) entendu(s)${names.length ? ` (${list(names)})` : ''}.`,
      ),
    none: both(
      'Scan done: no Switcher device heard. Check that they are on the same network as Gladys.',
      "Recherche faite : aucun appareil Switcher entendu. Vérifiez qu'ils sont sur le même réseau que Gladys.",
    ),
  },
};

/** The transport badge of a device. */
export const BADGE = {
  unreachable: both('Device unreachable.', 'Appareil injoignable.'),
  unconfirmed: both(
    'Address not confirmed by a recent scan: only stops are sent.',
    'Adresse non confirmée par une recherche récente : seuls les arrêts partent.',
  ),
  stopWaiting: both(
    'Stop kept, not sent yet: it leaves as soon as the device answers.',
    "Arrêt gardé, pas encore envoyé : il part dès que l'appareil répond.",
  ),
  stopSent: both('Stop sent, not seen applied yet.', 'Arrêt envoyé, pas encore vu appliqué.'),
  stopContradicted: both(
    'Stop sent 3 times, the device still reads on.',
    "Arrêt envoyé 3 fois, l'appareil se lit toujours en marche.",
  ),
  commandUnconfirmed: both(
    'Command sent, without confirmation yet.',
    'Commande envoyée, sans confirmation pour l’instant.',
  ),
  runEnded: both(
    'The water heater was still on after the run asked: the integration switched it off.',
    "Le chauffe-eau était encore en marche après la durée demandée : l'intégration l'a éteint.",
  ),
};

/** The errors of the commands (shown by Gladys when a command fails). */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both(
    'Value not accepted by this feature.',
    'Valeur non acceptée par cette fonctionnalité.',
  ),
  unknownDevice: both(
    'This device is not known to the integration: scan again from the Discovery tab.',
    "Cet appareil n'est pas connu de l'intégration : relancez une recherche depuis l'onglet Découverte.",
  ),
  heaterOff: both(
    'Switching the water heater on is disabled: allow it in the configuration of the integration (switching off needs no option).',
    "La mise en marche du chauffe-eau est désactivée : autorisez-la dans la configuration de l'intégration (l'arrêt ne dépend d'aucune option).",
  ),
  plugOff: both(
    'Switching the plug on is disabled: allow it in the configuration of the integration (switching off needs no option).',
    "La mise en marche de la prise est désactivée : autorisez-la dans la configuration de l'intégration (l'arrêt ne dépend d'aucune option).",
  ),
  shutterOff: both(
    'Moving the shutter is disabled: allow it in the configuration of the integration (stopping needs no option).',
    "Le déplacement du volet est désactivé : autorisez-le dans la configuration de l'intégration (l'arrêt ne dépend d'aucune option).",
  ),
  breezeOn: both(
    'Switching an air conditioner on is not supported by this version (switching off is).',
    "La mise en marche d'une climatisation n'est pas prise en charge par cette version (l'arrêt l'est).",
  ),
  breezeRemote: both(
    'The remote of this air conditioner has no plain "off" code: it cannot be switched off safely from Gladys.',
    "La télécommande de cette climatisation n'a pas de code « arrêt » simple : elle ne peut pas être éteinte sans risque depuis Gladys.",
  ),
  configUnread: both(
    'The configuration is not read yet: only stops are sent. Try again in a few seconds.',
    "La configuration n'est pas encore lue : seuls les arrêts partent. Réessayez dans quelques secondes.",
  ),
  identity: both(
    'The address of this device is not confirmed by a recent scan: nothing was sent (only stops are). Scan again from the Discovery tab.',
    "L'adresse de cet appareil n'est pas confirmée par une recherche récente : rien n'a été envoyé (seuls les arrêts partent). Relancez une recherche depuis l'onglet Découverte.",
  ),
  dataUnwritable: both(
    'The /data file cannot be written: nothing was sent (only stops are).',
    "Le fichier de /data ne peut pas être écrit : rien n'a été envoyé (seuls les arrêts partent).",
  ),
  stopping: both(
    'A stop of this device is being sent: nothing was sent.',
    "Un arrêt de cet appareil est en cours d'envoi : rien n'a été envoyé.",
  ),
  cancelled: both(
    'Cancelled by a stop of the same device: nothing was sent.',
    "Annulée par un arrêt du même appareil : rien n'a été envoyé.",
  ),
  notSent: both(
    'The device did not answer in time: nothing was sent.',
    "L'appareil n'a pas répondu à temps : rien n'a été envoyé.",
  ),
  stopKept: both(
    'The device did not answer: the stop is kept and sent as soon as it answers.',
    "L'appareil n'a pas répondu : l'arrêt est gardé et envoyé dès qu'il répond.",
  ),
};
