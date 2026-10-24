# HueControl - pilotage d'un pont Philips Hue (API CLIP v2) depuis PowerShell 5.1+

$script:Root = $PSScriptRoot
$script:Config = Get-Content (Join-Path $Root 'hue-config.json') -Raw | ConvertFrom-Json
$script:Base = "https://$($Config.BridgeIP)/clip/v2/resource"

# Le pont utilise un certificat auto-signe : on l'accepte uniquement pour son IP
if (-not ('HueCertPolicy' -as [type])) {
    Add-Type @"
using System.Net; using System.Security.Cryptography.X509Certificates;
public class HueCertPolicy : ICertificatePolicy {
    public static string BridgeHost;
    public bool CheckValidationResult(ServicePoint sp, X509Certificate c, WebRequest r, int p) {
        return r.RequestUri.Host == BridgeHost || p == 0;
    }
}
"@
}
[HueCertPolicy]::BridgeHost = $Config.BridgeIP
[System.Net.ServicePointManager]::CertificatePolicy = New-Object HueCertPolicy
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

#region Bas niveau

function Invoke-Hue {
    param([string]$Path, [string]$Method = 'GET', $Body)
    $params = @{
        Uri             = "$script:Base/$Path"
        Method          = $Method
        Headers         = @{ 'hue-application-key' = $script:Config.Username }
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        $params.Body = [Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    try {
        $r = Invoke-WebRequest @params
    } catch {
        $msg = $_.ErrorDetails.Message
        throw "Erreur Hue ($Method $Path) : $(if ($msg) { $msg } else { $_.Exception.Message })"
    }
    $res = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json
    if ($res.errors) { $res.errors | ForEach-Object { Write-Warning $_.description } }
    $res.data
}

function ConvertTo-HueKey([string]$s) {
    # Comparaison sans accents ni casse : "detente" == "Detente" accentue
    $n = $s.Normalize([Text.NormalizationForm]::FormD)
    (-join ($n.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne 'NonSpacingMark' })).ToLower().Trim()
}

function Find-HueItem($Items, [string]$Name, [string]$Kind) {
    $k = ConvertTo-HueKey $Name
    $hit = @($Items | Where-Object { (ConvertTo-HueKey $_.metadata.name) -eq $k })
    if (-not $hit) { $hit = @($Items | Where-Object { (ConvertTo-HueKey $_.metadata.name) -like "*$k*" }) }
    if ($hit.Count -eq 0) { throw "$Kind introuvable : '$Name'. Disponibles : $(($Items | ForEach-Object { $_.metadata.name }) -join ', ')" }
    if ($hit.Count -gt 1) { throw "$Kind ambigu : '$Name' correspond a $(($hit | ForEach-Object { $_.metadata.name }) -join ', ')" }
    $hit[0]
}

$script:Colors = @{
    rouge = 'FF0000'; vert = '00FF00'; bleu = '0000FF'; jaune = 'FFD000'; orange = 'FF7A00'
    violet = '8A2BE2'; rose = 'FF4FA0'; fuchsia = 'FF00FF'; cyan = '00FFFF'; blanc = 'FFFFFF'
    turquoise = '30D5C8'; magenta = 'FF00FF'
}

function ConvertTo-HueXY([string]$Color) {
    $hex = if ($script:Colors.ContainsKey((ConvertTo-HueKey $Color))) { $script:Colors[(ConvertTo-HueKey $Color)] } else { $Color.TrimStart('#') }
    if ($hex -notmatch '^[0-9a-fA-F]{6}$') { throw "Couleur inconnue '$Color'. Utilise un nom ($($script:Colors.Keys -join ', ')) ou un code #RRGGBB." }
    $rgb = 0, 2, 4 | ForEach-Object {
        $v = [Convert]::ToInt32($hex.Substring($_, 2), 16) / 255
        if ($v -gt 0.04045) { [Math]::Pow(($v + 0.055) / 1.055, 2.4) } else { $v / 12.92 }
    }
    $X = $rgb[0] * 0.4124 + $rgb[1] * 0.3576 + $rgb[2] * 0.1805
    $Y = $rgb[0] * 0.2126 + $rgb[1] * 0.7152 + $rgb[2] * 0.0722
    $Z = $rgb[0] * 0.0193 + $rgb[1] * 0.1192 + $rgb[2] * 0.9505
    $sum = $X + $Y + $Z
    if ($sum -eq 0) { return @{ x = 0.3127; y = 0.329 } }
    @{ x = [Math]::Round($X / $sum, 4); y = [Math]::Round($Y / $sum, 4) }
}

function New-HueState {
    param([switch]$On, [switch]$Off, [ValidateRange(1, 100)][int]$Brightness, [string]$Color,
          [ValidateRange(2000, 6500)][int]$Kelvin, [int]$TransitionMs)
    $s = @{}
    if ($On -or $Brightness -or $Color -or $Kelvin) { $s.on = @{ on = $true } }
    if ($Off) { $s.on = @{ on = $false } }
    if ($Brightness) { $s.dimming = @{ brightness = $Brightness } }
    if ($Color) { $s.color = @{ xy = (ConvertTo-HueXY $Color) } }
    if ($Kelvin) { $s.color_temperature = @{ mirek = [int](1000000 / $Kelvin) } }
    if ($PSBoundParameters.ContainsKey('TransitionMs')) { $s.dynamics = @{ duration = $TransitionMs } }
    if ($s.Count -eq 0) { throw "Rien a changer : precise -On, -Off, -Brightness, -Color ou -Kelvin." }
    $s
}

#endregion

#region Lumieres et pieces

function Get-HueLight {
    param([string]$Name)
    $lights = Invoke-Hue 'light'
    if ($Name) { $lights = @(Find-HueItem $lights $Name 'Lumiere') }
    $reach = @{}
    Invoke-Hue 'zigbee_connectivity' | ForEach-Object { $reach[$_.owner.rid] = $_.status }
    $lights | ForEach-Object {
        [pscustomobject]@{
            Nom        = $_.metadata.name
            Allumee    = $_.on.on
            Luminosite = [int]$_.dimming.brightness
            Joignable  = ($reach[$_.owner.rid] -eq 'connected')
            Id         = $_.id
        }
    } | Sort-Object Nom
}

function Set-HueLight {
    param([Parameter(Mandatory)][string]$Name, [switch]$On, [switch]$Off, [int]$Brightness,
          [string]$Color, [int]$Kelvin, [int]$TransitionMs)
    $l = Find-HueItem (Invoke-Hue 'light') $Name 'Lumiere'
    $p = @{} + $PSBoundParameters; $p.Remove('Name')
    Invoke-Hue "light/$($l.id)" PUT (New-HueState @p) | Out-Null
    Write-Host "OK : $($l.metadata.name)" -ForegroundColor Green
}

function Get-HueRoom {
    $grouped = @{}
    Invoke-Hue 'grouped_light' | ForEach-Object { $grouped[$_.id] = $_ }
    @(Invoke-Hue 'room') + @(Invoke-Hue 'zone') | ForEach-Object {
        $gid = ($_.services | Where-Object rtype -eq 'grouped_light').rid
        $gl = if ($gid) { $grouped[$gid] }
        [pscustomobject]@{
            Nom        = $_.metadata.name
            Allumee    = $gl.on.on
            Luminosite = [int]$gl.dimming.brightness
            Appareils  = @($_.children).Count
            Id         = $_.id
            GroupId    = $gl.id
        }
    }
}

function Set-HueRoom {
    param([Parameter(Mandatory)][string]$Name, [switch]$On, [switch]$Off, [int]$Brightness,
          [string]$Color, [int]$Kelvin, [int]$TransitionMs)
    $r = Find-HueItem (@(Invoke-Hue 'room') + @(Invoke-Hue 'zone')) $Name 'Piece'
    $gid = ($r.services | Where-Object rtype -eq 'grouped_light').rid
    $p = @{} + $PSBoundParameters; $p.Remove('Name')
    Invoke-Hue "grouped_light/$gid" PUT (New-HueState @p) | Out-Null
    Write-Host "OK : $($r.metadata.name)" -ForegroundColor Green
}

function Get-HueScene {
    param([string]$Room)
    $rooms = @{}
    @(Invoke-Hue 'room') + @(Invoke-Hue 'zone') | ForEach-Object { $rooms[$_.id] = $_.metadata.name }
    Invoke-Hue 'scene' | ForEach-Object {
        [pscustomobject]@{ Nom = $_.metadata.name; Piece = $rooms[$_.group.rid]; Active = $_.status.active; Id = $_.id }
    } | Where-Object { -not $Room -or (ConvertTo-HueKey $_.Piece) -like "*$(ConvertTo-HueKey $Room)*" } | Sort-Object Piece, Nom
}

function Start-HueScene {
    param([Parameter(Mandatory)][string]$Name, [int]$Brightness)
    $s = Find-HueItem (Invoke-Hue 'scene') $Name 'Scene'
    $body = @{ recall = @{ action = 'active' } }
    if ($Brightness) { $body.recall.dimming = @{ brightness = $Brightness } }
    Invoke-Hue "scene/$($s.id)" PUT $body | Out-Null
    Write-Host "Scene lancee : $($s.metadata.name)" -ForegroundColor Green
}

function Set-HueAll {
    param([switch]$On, [switch]$Off)
    Get-HueRoom | ForEach-Object { Set-HueRoom -Name $_.Nom -On:$On -Off:$Off }
}

#endregion

#region Telecommande (Tap Dial / Dimmer / Smart button)

function Get-HueRemoteBehavior {
    param([string]$Name)
    $script = (Invoke-Hue 'behavior_script' | Where-Object { $_.metadata.name -eq 'Tap Switch' -or $_.metadata.name -eq 'Hue Accessories' }).id
    $b = @(Invoke-Hue 'behavior_instance' | Where-Object { $script -contains $_.script_id })
    if ($Name) { $b = @(Find-HueItem $b $Name 'Telecommande') }
    $b
}

function Format-HueAction($cfg, $scenes) {
    if ($null -eq $cfg) { return '-' }
    if ($cfg.action) {
        $label = @{ all_off = 'Tout eteindre'; last_on = 'Rallumer (dernier etat)' }[$cfg.action]
        return $(if ($label) { $label } else { $cfg.action })
    }
    $name = { param($a) $scenes[$a.action.recall.rid] }
    if ($cfg.recall_single_extended) { return "Scene : " + (& $name $cfg.recall_single_extended.actions[0]) }
    if ($cfg.scene_cycle_extended) { return "Cycle : " + (($cfg.scene_cycle_extended.slots | ForEach-Object { & $name $_[0] }) -join ' > ') }
    if ($cfg.time_based_extended) {
        return "Selon l'heure : " + (($cfg.time_based_extended.slots | ForEach-Object { '{0:00}h{1:00} {2}' -f $_.start_time.hour, $_.start_time.minute, (& $name $_.actions[0]) }) -join ' | ')
    }
    ($cfg | ConvertTo-Json -Compress -Depth 10)
}

function Get-HueRemote {
    $scenes = @{}; Invoke-Hue 'scene' | ForEach-Object { $scenes[$_.id] = $_.metadata.name }
    Get-HueRemoteBehavior | ForEach-Object {
        $c = $_.configuration
        Write-Host "`n== $($_.metadata.name) ==" -ForegroundColor Cyan
        foreach ($i in 1..4) {
            $btn = $c."button$i"
            if (-not $btn) { continue }
            Write-Host ("  Bouton {0}  appui court : {1}" -f $i, (Format-HueAction $btn.on_short_release $scenes))
            Write-Host ("            appui long  : {0}" -f (Format-HueAction $btn.on_long_press $scenes))
        }
        if ($c.rotary) {
            Write-Host ("  Molette   tourner (eteint) : {0}" -f (Format-HueAction $c.rotary.on_dim_on.recall_single[0] $scenes))
        }
    }
}

function Backup-HueRemote {
    $file = Join-Path $script:Root ("backup-telecommande-{0:yyyyMMdd-HHmmss}.json" -f (Get-Date))
    ConvertTo-Json -InputObject @(Get-HueRemoteBehavior) -Depth 20 | Out-File -Encoding utf8 $file
    Write-Host "Sauvegarde : $file" -ForegroundColor DarkGray
}

function Set-HueRemoteButton {
    <#
    .EXAMPLE Set-HueRemoteButton -Button 2 -Scene 'Lecture'
    .EXAMPLE Set-HueRemoteButton -Button 3 -Cycle 'Detente','Lecture','Concentration'
    .EXAMPLE Set-HueRemoteButton -Button 4 -Press Long -AllOff
    #>
    [CmdletBinding(DefaultParameterSetName = 'Scene')]
    param(
        [Parameter(Mandatory)][ValidateRange(1, 4)][int]$Button,
        [ValidateSet('Court', 'Long')][string]$Press = 'Court',
        [Parameter(ParameterSetName = 'Scene', Mandatory)][string]$Scene,
        [Parameter(ParameterSetName = 'Cycle', Mandatory)][string[]]$Cycle,
        [Parameter(ParameterSetName = 'Off', Mandatory)][switch]$AllOff,
        [string]$Remote
    )
    $b = @(Get-HueRemoteBehavior $Remote)
    if ($b.Count -ne 1) { throw "Plusieurs telecommandes : precise -Remote ($(($b | ForEach-Object { $_.metadata.name }) -join ', '))" }
    $b = $b[0]
    $allScenes = Invoke-Hue 'scene'
    $recall = { param($n) , @(@{ action = @{ recall = @{ rid = (Find-HueItem $allScenes $n 'Scene').id; rtype = 'scene' } } }) }

    $action = switch ($PSCmdlet.ParameterSetName) {
        'Scene' { @{ recall_single_extended = @{ actions = (& $recall $Scene); with_off = @{ enabled = $false } } } }
        'Cycle' { @{ scene_cycle_extended = @{ slots = @($Cycle | ForEach-Object { , (& $recall $_) }); with_off = @{ enabled = $false } } } }
        'Off'   { @{ action = 'all_off' } }
    }
    if ($Press -eq 'Long' -and $PSCmdlet.ParameterSetName -eq 'Cycle') { throw "Le cycle de scenes n'est possible qu'en appui court." }

    Backup-HueRemote
    $cfg = $b.configuration
    $key = if ($Press -eq 'Court') { 'on_short_release' } else { 'on_long_press' }
    $cfg."button$Button" | Add-Member -NotePropertyName $key -NotePropertyValue $action -Force
    Invoke-Hue "behavior_instance/$($b.id)" PUT @{ configuration = $cfg } | Out-Null
    Write-Host "Bouton $Button ($Press) mis a jour." -ForegroundColor Green
}

#endregion

#region Alexa

$script:Dash = 'http://127.0.0.1:8090'

function Find-AlexaByName($Devices, [string]$Name) {
    $k = ConvertTo-HueKey $Name
    $hit = @($Devices | Where-Object { (ConvertTo-HueKey $_.name) -eq $k })
    if (-not $hit) { $hit = @($Devices | Where-Object { (ConvertTo-HueKey $_.name) -like "*$k*" }) }
    if ($hit.Count -ne 1) { throw "Alexa '$Name' introuvable ou ambigue. Disponibles : $(($Devices | ForEach-Object name) -join ', ')" }
    $hit[0]
}

function Invoke-AlexaViaServer($Srv, $Command, $Device, $Value) {
    $post = {
        param($Path, $Body)
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
        Invoke-RestMethod "$script:Dash$Path" -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 20 | Out-Null
    }
    if ($Command -eq 'list') {
        return [pscustomobject]@{ ok = $true; devices = @($Srv.devices | ForEach-Object {
            [pscustomobject]@{ name = $_.name; group = $_.group; members = $_.members; online = $_.online; volume = $_.volume; playing = $_.player } }) }
    }
    $d = Find-AlexaByName $Srv.devices $Device
    switch ($Command) {
        'volume' {
            $cur = if ($null -ne $d.volume) { [int]$d.volume } else { 20 }
            $v = if ($Value -match '^[+-]') { $cur + [int]$Value } else { [int]$Value }
            $v = [Math]::Max(0, [Math]::Min(100, $v))
            & $post '/api/alexa/volume' @{ serial = $d.serial; volume = $v }
            $names = if ($d.group) { $d.members } else { @($d.name) }
            return [pscustomobject]@{ ok = $true; result = @($names | ForEach-Object { [pscustomobject]@{ name = $_; volume = $v } }) }
        }
        { $_ -in 'play', 'pause', 'next', 'previous' } { & $post '/api/alexa/media' @{ serial = $d.serial; action = $Command } }
        'stop'  { & $post '/api/alexa/stop' @{ serial = $d.serial } }
        'music' { & $post '/api/alexa/music' @{ serial = $d.serial; search = $Value } }
        'speak' { & $post '/api/alexa/speak' @{ serial = $d.serial; text = $Value } }
        'cmd'   { & $post '/api/alexa/cmd' @{ serial = $d.serial; text = $Value } }
    }
    [pscustomobject]@{ ok = $true }
}

function Invoke-Alexa {
    # Passe par le dashboard s'il tourne (instantane), sinon par l'outil node (~3 s)
    param([Parameter(Mandatory)][string]$Command, [string]$Device, [string]$Value)
    $srv = $null
    try { $srv = Invoke-RestMethod "$script:Dash/api/alexa" -TimeoutSec 2 } catch { }
    if ($srv -and $srv.ready) {
        try { return Invoke-AlexaViaServer $srv $Command $Device $Value }
        catch { throw "Alexa : $(if ($_.ErrorDetails.Message) { ($_.ErrorDetails.Message | ConvertFrom-Json).error } else { $_.Exception.Message })" }
    }
    $cli = Join-Path $script:Root 'alexa\alexa-cli.js'
    $nodeArgs = @('--no-deprecation', $cli, $Command)
    if ($Device) { $nodeArgs += $Device }
    if ($Value) { $nodeArgs += $Value }
    $prev = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $raw = & node @nodeArgs 2>$null
    } finally { [Console]::OutputEncoding = $prev }
    $res = ($raw | Select-Object -Last 1) | ConvertFrom-Json
    if (-not $res.ok) { throw "Alexa : $($res.error)" }
    $res
}

function Get-AlexaDevice {
    (Invoke-Alexa list).devices | ForEach-Object {
        $p = $_.playing
        [pscustomobject]@{
            Nom      = $_.name
            Type     = if ($_.group) { 'Groupe (' + ($_.members -join ', ') + ')' } else { 'Echo' }
            EnLigne  = $_.online
            Volume   = $_.volume
            Lecture  = if ($p) { "$($p.title) - $($p.artist)" } else { '' }
            Etat     = if ($p) { $p.state } else { '' }
            Progres  = if ($p -and $p.length) { [int]$p.progress } else { $null }
            Duree    = if ($p -and $p.length) { [int]$p.length } else { $null }
        }
    }
}

function Set-AlexaVolume {
    <#
    .EXAMPLE Set-AlexaVolume Noir 30
    .EXAMPLE Set-AlexaVolume Chambre +10     (groupe : chaque Echo du groupe)
    #>
    param([Parameter(Mandatory)][string]$Device, [Parameter(Mandatory)][string]$Volume)
    (Invoke-Alexa volume $Device $Volume).result | ForEach-Object { Write-Host "$($_.name) : volume $($_.volume)" -ForegroundColor Green }
}

function Invoke-AlexaMedia {
    param([Parameter(Mandatory)][string]$Device,
          [Parameter(Mandatory)][ValidateSet('play', 'pause', 'next', 'previous', 'stop')][string]$Action)
    Invoke-Alexa $Action $Device | Out-Null
    Write-Host "OK : $Action sur $Device" -ForegroundColor Green
}

function Start-AlexaMusic {
    <# .EXAMPLE Start-AlexaMusic Chambre 'du jazz sur Spotify' #>
    param([Parameter(Mandatory)][string]$Device, [Parameter(Mandatory)][string]$Search)
    Invoke-Alexa music $Device $Search | Out-Null
    Write-Host "Lecture demandee sur $Device : $Search" -ForegroundColor Green
}

function Send-AlexaSpeak {
    param([Parameter(Mandatory)][string]$Device, [Parameter(Mandatory)][string]$Text)
    Invoke-Alexa speak $Device $Text | Out-Null
}

function Send-AlexaCommand {
    <# .EXAMPLE Send-AlexaCommand Bleu 'quelle heure est-il' #>
    param([Parameter(Mandatory)][string]$Device, [Parameter(Mandatory)][string]$Text)
    Invoke-Alexa cmd $Device $Text | Out-Null
    Write-Host "Commande envoyee a $Device" -ForegroundColor Green
}

function Format-AlexaBar([int]$Value, [int]$Width = 20) {
    $n = [Math]::Round($Value / 100 * $Width)
    ('#' * $n) + ('.' * ($Width - $n))
}

function Show-AlexaMenu {
    Write-Host "Connexion a Alexa..." -ForegroundColor DarkGray
    $devs = @(Get-AlexaDevice)
    $cur = ($devs | Where-Object Nom -eq 'Chambre' | Select-Object -First 1).Nom
    if (-not $cur) { $cur = $devs[0].Nom }
    while ($true) {
        Clear-Host
        Write-Host "======================== ALEXA ========================" -ForegroundColor Yellow
        for ($i = 0; $i -lt $devs.Count; $i++) {
            $d = $devs[$i]
            $mark = if ($d.Nom -eq $cur) { '>' } else { ' ' }
            $color = if ($d.Nom -eq $cur) { 'Cyan' } elseif (-not $d.EnLigne) { 'DarkGray' } else { 'Gray' }
            $vol = if ($null -ne $d.Volume) { "[{0}] {1,3}" -f (Format-AlexaBar $d.Volume 10), $d.Volume } else { '' }
            $grp = if ($d.Type -like 'Groupe*') { '(groupe)' } else { '' }
            Write-Host ("{0}[{1}] {2,-14} {3,-9} {4}" -f $mark, ($i + 1), $d.Nom, $grp, $vol) -ForegroundColor $color
            if (-not $d.EnLigne) { Write-Host "       hors ligne" -ForegroundColor DarkGray }
            elseif ($d.Lecture) {
                $icon = if ($d.Etat -eq 'PLAYING') { '>' } else { '||' }
                Write-Host ("       {0} {1}" -f $icon, $d.Lecture) -ForegroundColor Magenta
                if ($d.Duree) {
                    $pct = [int](100 * $d.Progres / $d.Duree)
                    Write-Host ("         [{0}] {1:mm\:ss} / {2:mm\:ss}" -f (Format-AlexaBar $pct 30), [TimeSpan]::FromSeconds($d.Progres), [TimeSpan]::FromSeconds($d.Duree)) -ForegroundColor DarkMagenta
                }
            }
        }
        Write-Host "--------------------------------------------------------"
        Write-Host "  Appareil actif : $cur   (tape son numero pour changer)" -ForegroundColor Cyan
        Write-Host "  [+] Volume +5    [-] Volume -5    [V] Volume precis"
        Write-Host "  [P] Lecture/Pause  [S] Suivant  [A] Precedent  [X] Stop"
        Write-Host "  [M] Lancer une musique   [D] Faire parler   [C] Commande libre"
        Write-Host "  [T] Volume de TOUTES les Alexa"
        Write-Host "  [R] Rafraichir   [Q] Retour"
        $c = (Read-Host "`nAction").Trim().ToUpper()
        if ($c -eq 'Q') { return }
        try {
            if ($c -match '^\d+$') {
                if ([int]$c -ge 1 -and [int]$c -le $devs.Count) { $cur = $devs[[int]$c - 1].Nom }
                continue
            }
            $sel = $devs | Where-Object Nom -eq $cur | Select-Object -First 1
            switch ($c) {
                '+' { Set-AlexaVolume $cur '+5' }
                '-' { Set-AlexaVolume $cur '-5' }
                'V' { Set-AlexaVolume $cur (Read-Host 'Volume (0-100, ou +10 / -10)') }
                'P' { if ($sel.Etat -eq 'PLAYING') { Invoke-AlexaMedia $cur pause } else { Invoke-AlexaMedia $cur play } }
                'S' { Invoke-AlexaMedia $cur next }
                'A' { Invoke-AlexaMedia $cur previous }
                'X' { Invoke-AlexaMedia $cur stop }
                'M' { $q = Read-Host 'Quoi jouer ? (ex. du rap sur Spotify, la radio NRJ)'; if ($q) { Start-AlexaMusic $cur $q } }
                'D' { $q = Read-Host 'Texte a dire'; if ($q) { Send-AlexaSpeak $cur $q } }
                'C' { $q = Read-Host 'Commande (comme si tu parlais a Alexa)'; if ($q) { Send-AlexaCommand $cur $q } }
                'T' {
                    $v = Read-Host 'Volume pour toutes les Alexa (0-100)'
                    $devs | Where-Object { $_.EnLigne -and $_.Type -eq 'Echo' -and $null -ne $_.Volume } | ForEach-Object { Set-AlexaVolume $_.Nom $v }
                }
            }
            if ($c -in 'P', 'S', 'A', 'X', 'M') { Start-Sleep -Seconds 2 }
            $devs = @(Get-AlexaDevice)
        } catch { Write-Host $_ -ForegroundColor Red; Read-Host "(Entree)" | Out-Null }
    }
}
#endregion

#region Menu interactif

function Read-HueChoice($Title, $Items) {
    Write-Host "`n$Title" -ForegroundColor Cyan
    for ($i = 0; $i -lt $Items.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $Items[$i]) }
    $n = Read-Host "Choix (Entree = annuler)"
    if ($n -match '^\d+$' -and [int]$n -ge 1 -and [int]$n -le $Items.Count) { return [int]$n - 1 }
    -1
}

function Show-HueMenu {
    while ($true) {
        Clear-Host
        Write-Host "=================== HUE CONTROL ===================" -ForegroundColor Yellow
        Get-HueRoom | Where-Object Appareils | ForEach-Object {
            $etat = if ($_.Allumee) { "ALLUMEE [{0}] {1}%" -f (Format-AlexaBar $_.Luminosite 10), $_.Luminosite } else { 'eteinte' }
            Write-Host ("  {0,-20} {1}" -f $_.Nom, $etat) -ForegroundColor $(if ($_.Allumee) { 'Yellow' } else { 'Gray' })
        }
        Get-HueLight | ForEach-Object {
            $etat = if (-not $_.Joignable) { 'injoignable' } elseif ($_.Allumee) { "on  {0}%" -f $_.Luminosite } else { 'off' }
            Write-Host ("     - {0,-18} {1}" -f $_.Nom, $etat) -ForegroundColor $(if (-not $_.Joignable) { 'DarkGray' } elseif ($_.Allumee) { 'White' } else { 'Gray' })
        }
        Write-Host "---------------------------------------------------"
        Write-Host "  [1] Allumer / eteindre une piece"
        Write-Host "  [2] Regler la luminosite d'une piece"
        Write-Host "  [3] Lancer une scene"
        Write-Host "  [4] Regler UNE lumiere (on/off, luminosite, couleur)"
        Write-Host "  [5] Voir les lumieres"
        Write-Host "  [6] Voir la telecommande"
        Write-Host "  [7] Configurer un bouton de la telecommande"
        Write-Host "  [8] ALEXA : volume, musique..."
        Write-Host "  [0] Tout eteindre"
        Write-Host "  [Q] Quitter"
        $c = Read-Host "`nAction"
        try {
            switch ($c) {
                '1' {
                    $rooms = @(Get-HueRoom); $i = Read-HueChoice 'Piece :' ($rooms | ForEach-Object Nom)
                    if ($i -ge 0) { if ($rooms[$i].Allumee) { Set-HueRoom $rooms[$i].Nom -Off } else { Set-HueRoom $rooms[$i].Nom -On } }
                }
                '2' {
                    $rooms = @(Get-HueRoom); $i = Read-HueChoice 'Piece :' ($rooms | ForEach-Object Nom)
                    if ($i -ge 0) { Set-HueRoom $rooms[$i].Nom -Brightness ([int](Read-Host 'Luminosite (1-100)')) }
                }
                '3' {
                    $sc = @(Get-HueScene); $i = Read-HueChoice 'Scene :' ($sc | ForEach-Object { "$($_.Nom)  ($($_.Piece))" })
                    if ($i -ge 0) { Start-HueScene $sc[$i].Nom }
                }
                '4' {
                    $l = @(Get-HueLight); $i = Read-HueChoice 'Lumiere :' ($l | ForEach-Object { "$($_.Nom)  ($(if ($_.Allumee) { "on $($_.Luminosite)%" } else { 'off' }))" })
                    if ($i -ge 0) {
                        $name = $l[$i].Nom
                        $t = Read-HueChoice "$name :" @('Allumer', 'Eteindre', 'Luminosite', 'Couleur', 'Blanc (chaud / froid)')
                        switch ($t) {
                            0 { Set-HueLight $name -On }
                            1 { Set-HueLight $name -Off }
                            2 { Set-HueLight $name -Brightness ([int](Read-Host 'Luminosite (1-100)')) }
                            3 { Set-HueLight $name -Color (Read-Host "Couleur ($($script:Colors.Keys -join ', ') ou #RRGGBB)") }
                            4 { Set-HueLight $name -Kelvin ([int](Read-Host 'Kelvin : 2200 = tres chaud, 2700 = chaud, 4000 = neutre, 6500 = froid')) }
                        }
                    }
                }
                '5' { Get-HueLight | Format-Table Nom, Allumee, Luminosite, Joignable -AutoSize | Out-Host }
                '6' { Get-HueRemote }
                '7' {
                    Get-HueRemote
                    $btn = Read-Host "`nBouton (1-4)"
                    $press = if ((Read-Host 'Appui [C]ourt ou [L]ong ?') -match '^[lL]') { 'Long' } else { 'Court' }
                    $t = Read-HueChoice 'Action :' @('Lancer une scene', 'Faire defiler plusieurs scenes', 'Tout eteindre')
                    $sc = @(Get-HueScene)
                    switch ($t) {
                        0 { $i = Read-HueChoice 'Scene :' ($sc | ForEach-Object Nom); if ($i -ge 0) { Set-HueRemoteButton -Button $btn -Press $press -Scene $sc[$i].Nom } }
                        1 {
                            for ($k = 0; $k -lt $sc.Count; $k++) { Write-Host ("  [{0}] {1}" -f ($k + 1), $sc[$k].Nom) }
                            $nums = (Read-Host 'Numeros separes par des virgules (ex. 1,4,7)') -split ',' | ForEach-Object { [int]$_.Trim() - 1 }
                            Set-HueRemoteButton -Button $btn -Cycle ($nums | ForEach-Object { $sc[$_].Nom })
                        }
                        2 { Set-HueRemoteButton -Button $btn -Press $press -AllOff }
                    }
                }
                '8' { Show-AlexaMenu; continue }
                '0' { Set-HueAll -Off }
                { $_ -in 'q', 'Q' } { return }
            }
        } catch { Write-Host $_ -ForegroundColor Red }
        Read-Host "`n(Entree pour continuer)" | Out-Null
    }
}

#endregion

Set-Alias hue Show-HueMenu
Export-ModuleMember -Function Get-HueLight, Set-HueLight, Get-HueRoom, Set-HueRoom, Get-HueScene, Start-HueScene, Set-HueAll,
    Get-HueRemote, Set-HueRemoteButton, Backup-HueRemote, Show-HueMenu, Invoke-Hue,
    Get-AlexaDevice, Set-AlexaVolume, Invoke-AlexaMedia, Start-AlexaMusic, Send-AlexaSpeak, Send-AlexaCommand, Show-AlexaMenu -Alias hue
