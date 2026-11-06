# Switcher

Intégration Gladys non officielle pour les appareils **Switcher** de votre
réseau local : chauffe-eau (V2, V4, Mini, Touch), **Power Plug**, volets
**Runner** et **Runner Mini**, climatisations **Breeze**. L'intégration parle
au protocole local des appareils, sans cloud : ils s'annoncent en diffusion UDP
(captée par Gladys), puis sont lus et commandés en TCP (ports 9957 et 10000).

Jamais testé avec un vrai appareil : l'intégration suit le protocole tel que la
bibliothèque aioswitcher (utilisée par Home Assistant) le lit et l'écrit, et les
trames enregistrées par ses tests. Sans lien avec Switcher.

## Ce que vous obtenez

- **Chauffe-eau** : marche/arrêt, puissance consommée (W), temps restant de la
  marche en cours.
- **Power Plug** : marche/arrêt, puissance consommée (W).
- **Runner, Runner Mini** : position (0 fermé, 100 ouvert), ouvrir, fermer,
  arrêter.
- **Breeze** : état (marche/arrêt), température de la pièce, consigne et mode
  (en lecture), arrêt.

Non pris en charge : les modèles qui exigent le **jeton du compte Switcher**
(Runner S11, Runner S12, Lights SL01/SL02/SL03, Heater). Ce jeton se demande
sur le site du fabricant, mais pour s'en servir il faut le décoder avec une
clé tirée de l'application Switcher, ce qui revient à imiter l'application.
Ces appareils sont nommés dans le statut et par le bouton « Chercher les
appareils », jamais pilotés.

## Configuration

1. Donnez une adresse IP fixe à chaque appareil dans votre routeur (conseillé ;
   une adresse qui change est suivie par les recherches).
2. Installez l'intégration, puis ouvrez l'onglet **Découverte** et lancez une
   recherche : Gladys écoute les annonces des appareils quelques secondes.
3. Ajoutez les appareils trouvés.
4. Si vous le souhaitez, cochez les commandes autorisées (toutes désactivées
   par défaut) :
   - **Autoriser la mise en marche des chauffe-eau**, avec la **durée de
     marche** (1 à 150 minutes, 60 par défaut) ;
   - **Autoriser la mise en marche des prises** ;
   - **Autoriser le déplacement des volets** (ouvrir, fermer, positionner).

Chaque appareil ajouté est lu toutes les 30 secondes (réglable de 10 à 600), pas
plus souvent, redémarrage compris (l'heure de la dernière lecture est gardée
dans /data), sauf après une commande ou un arrêt : l'appareil est alors relu 5
et 20 secondes plus tard.
Une recherche a lieu toutes les 5 minutes : un appareil n'est commandé (hors
arrêts) que si une recherche l'a vu à son adresse dans les 15 dernières minutes,
et n'est plus lu quand les recherches qui marchent ne l'entendent plus depuis
15 minutes (des recherches en échec ne l'arrêtent pas).

## Les arrêts

Éteindre un chauffe-eau, une prise ou une Breeze, et arrêter un volet ne
dépendent d'aucune option, d'aucune lecture préalable, ni de la configuration
de Gladys (les appareils connus et les arrêts sont gardés dans /data) ; ils
partent même vers un appareil qu'aucune recherche récente n'a vu (à sa dernière
adresse connue). Un arrêt passe devant les lectures et les commandes, annule les
commandes du même appareil qui attendent, et coupe la session en cours avec lui.

Un arrêt qui ne peut pas partir (appareil injoignable) est réessayé pendant
3 secondes, puis gardé : réessayé 10 et 30 secondes plus tard, puis chaque
minute, et avant chaque lecture. Gladys l'affiche en erreur (« l'arrêt est
gardé et envoyé dès qu'il répond ») et le statut le dit. Un arrêt envoyé est
confirmé par une lecture faite après lui ; tant qu'une telle lecture montre
l'appareil en marche, il est renvoyé, 3 envois au plus. Il reste gardé (dans
/data) jusqu'à une lecture qui le montre éteint ou une mise en marche depuis
Gladys qui est partie ; le temps seul ne le lève pas.

Un arrêt est refusé dans ces cas seulement :

- une Breeze dont la télécommande n'a pas de code « arrêt » simple (télécommande
  à bascule, où le même code allume et éteint, ou télécommande inconnue) : son
  état est affiché en lecture seule ;
- un appareil que l'intégration ne connaît pas (ni par une recherche, ni par les
  paramètres de l'appareil créé dans Gladys).

L'arrêt d'un volet est une commande d'un instant : gardé en mémoire seulement,
il est réessayé pendant 3 minutes (le temps de la course d'un volet), puis
abandonné, et il n'est jamais rejoué après un redémarrage (il arrêterait un
mouvement lancé depuis).

## Les autres commandes

Mise en marche d'un chauffe-eau, d'une prise, et déplacement d'un volet :

- refusées si l'option n'est pas cochée, si la configuration n'est pas encore
  lue, si l'adresse de l'appareil n'est pas confirmée par une recherche récente,
  si /data ne peut pas être écrit, ou pendant l'envoi d'un arrêt du même
  appareil ;
- l'option, l'échéance et l'annulation sont revérifiées juste avant l'envoi ;
  une commande qui n'est pas partie dans les 3 secondes est refusée (« rien
  n'a été envoyé ») ;
- une commande partie est confirmée seulement par une lecture faite après elle
  qui montre la valeur demandée ; sinon l'appareil porte « Commande envoyée,
  sans confirmation » jusqu'à ce qu'une lecture la montre.

Chaque mise en marche d'un chauffe-eau porte la **minuterie** de l'appareil
(la durée de marche configurée) : il s'arrête de lui-même à la fin. Si une
lecture le montre encore en marche 2 minutes après la fin de cette durée (et
que rien ne l'a rallumé entre-temps), l'intégration l'éteint elle-même (un
arrêt comme les autres) ; cette marche est gardée dans /data et suivie après un
redémarrage. La mise en marche d'une Breeze n'est pas prise en charge par cette
version.

## Sécurité

Le protocole local de Switcher n'a pas de mot de passe : n'importe quel
appareil de votre réseau peut piloter vos Switcher. Gardez-les sur un réseau de
confiance. L'intégration ne garde aucun secret.

## En cas de problème

- « Aucun appareil Switcher trouvé » : les appareils doivent être sur le même
  réseau local que Gladys (la diffusion UDP ne traverse pas les routeurs).
- « La recherche réseau de Gladys n'est pas disponible » : il faut une version
  de Gladys qui propose la découverte réseau aux intégrations (5.1 ou plus).
- Un appareil « injoignable » : vérifiez son adresse et qu'aucun pare-feu ne
  bloque les ports TCP 9957 (chauffe-eau, prise) et 10000 (Runner, Breeze).
