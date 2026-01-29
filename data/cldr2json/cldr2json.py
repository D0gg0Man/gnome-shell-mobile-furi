#!/usr/bin/python3
#
# Copyright 2015  Daiki Ueno <dueno@src.gnome.org>
#           2016  Parag Nemade <pnemade@redhat.com>
#           2017  Alan <alan@boum.org>
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU Lesser General Public License as
# published by the Free Software Foundation; either version 2 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this program; if not, see
# <http://www.gnu.org/licenses/>.

import glob
import json
import locale
import logging
import os
import re
import sys
import xml.etree.ElementTree

import gi
gi.require_version('GnomeDesktop', '3.0')   # NOQA: E402
from gi.repository import GnomeDesktop

ESCAPE_PATTERN = re.compile(r'\\u\{([0-9A-Fa-f]+?)\}')
ISO_PATTERN = re.compile(r'[A-E]([0-9]+)')

LOCALE_TO_XKB_OVERRIDES = {
    'af':    'za',
    'en':    'us',
    'en-GB': 'uk',
    'es-US': 'latam',
    'fr-CA': 'ca',
    'hi':    'in+bolnagri',
    'ky':    'kg',
    'nl-BE': 'be',
    'zu':    None
}


def parse_single_key(value):
    def unescape(m):
        return chr(int(m.group(1), 16))
    value = ESCAPE_PATTERN.sub(unescape, value)
    return value


def parse_rows(keymap):
    unsorted_rows = {}
    for _map in keymap.iter('map'):
        value = _map.get('to')
        key = [parse_single_key(value)]
        iso = _map.get('iso')
        if not ISO_PATTERN.match(iso):
            sys.stderr.write('invalid ISO key name: %s\n' % iso)
            continue
        if not iso[0] in unsorted_rows:
            unsorted_rows[iso[0]] = []
        unsorted_rows[iso[0]].append((int(iso[1:]), key))
        # add subkeys
        longPress = _map.get('longPress')
        if longPress:
            for value in longPress.split(' '):
                subkey = parse_single_key(value)
                key.append(subkey)

    rows = []
    for k, v in sorted(list(unsorted_rows.items()),
                       key=lambda x: x[0],
                       reverse=True):
        row = []
        for key in sorted(v, key=lambda x: x):
            row.append({ 'strings': key[1] })
        rows.append(row)

    return rows


def convert_xml(tree):
    root = {}
    for xml_keyboard in tree.iter("keyboard"):
        locale_full = xml_keyboard.get("locale")
        locale, sep, end = locale_full.partition("-t-")
    root["locale"] = locale
    for xml_name in tree.iter("name"):
        name = xml_name.get("value")
    root["name"] = name
    root["levels"] = []
    # parse levels
    for index, keymap in enumerate(tree.iter('keyMap')):
        # FIXME: heuristics here
        modifiers = keymap.get('modifiers')
        if not modifiers:
            mode = 'default'
            modifiers = 'default'
        elif 'shift' in modifiers.split(' '):
            mode = 'latched'
            modifiers = 'shift'
        else:
            mode = 'locked'
        level = {}
        level["level"] = modifiers
        level["mode"] = mode
        level["rows"] = parse_rows(keymap)
        root["levels"].append(level)
    return root


def locale_to_xkb(locale, name):
    if locale in sorted(LOCALE_TO_XKB_OVERRIDES.keys()):
        xkb = LOCALE_TO_XKB_OVERRIDES[locale]
        logging.debug("override for %s → %s",
                      locale, xkb)
        if xkb:
            return xkb
        else:
            raise KeyError("layout %s explicitly disabled in overrides"
                           % locale)
    xkb_names = sorted(name_to_xkb.keys())
    if name in xkb_names:
        return name_to_xkb[name]
    else:
        logging.debug("name %s failed" % name)
    for sub_name in name.split(' '):
        if sub_name in xkb_names:
            xkb = name_to_xkb[sub_name]
            logging.debug("dumb mapping failed but match with locale word: "
                          "%s (%s) → %s (%s)",
                          locale, name, xkb, sub_name)
            return xkb
        else:
            logging.debug("sub_name failed")
    for xkb_name in xkb_names:
        for xkb_sub_name in xkb_name.split(' '):
            if xkb_sub_name.strip('()') == name:
                xkb = name_to_xkb[xkb_name]
                logging.debug("dumb mapping failed but match with xkb word: "
                              "%s (%s) → %s (%s)",
                              locale, name, xkb, xkb_name)
                return xkb
    raise KeyError("failed to find XKB mapping for %s" % locale)

def create_char_key(strings=None, keyval=None, label=None, iconName=None, width=None, height=None, leftOffset=None, rightOffset=None):
    obj = {}

    if (keyval is not None):
        obj["keyval"] = keyval
    if (label is not None):
        obj["label"] = label
    elif (strings is not None):
        obj["strings"] = strings
    if (iconName is not None):
        obj["iconName"] = iconName
    if (width is not None):
        obj["width"] = width
    if (height is not None):
        obj["height"] = height
    if (leftOffset is not None):
        obj["leftOffset"] = leftOffset
    if (rightOffset is not None):
        obj["rightOffset"] = rightOffset

    return obj

def create_action_key(action, level=None, label=None, iconName=None, width=None, height=None, leftOffset=None, rightOffset=None):
    obj = { "action": action }

    if (level is not None):
        obj["level"] = level
    if (label is not None):
        obj["label"] = label
    if (iconName is not None):
        obj["iconName"] = iconName
    if (width is not None):
        obj["width"] = width
    if (height is not None):
        obj["height"] = height
    if (leftOffset is not None):
        obj["leftOffset"] = leftOffset
    if (rightOffset is not None):
        obj["rightOffset"] = rightOffset

    return obj

def create_modifier_key(keyval=None, label=None, iconName=None, width=None, height=None, leftOffset=None, rightOffset=None):
    obj = { "keyval": keyval, "action": "modifier" }

    if (label is not None):
        obj["label"] = label
    if (iconName is not None):
        obj["iconName"] = iconName
    if (width is not None):
        obj["width"] = width
    if (height is not None):
        obj["height"] = height
    if (leftOffset is not None):
        obj["leftOffset"] = leftOffset
    if (rightOffset is not None):
        obj["rightOffset"] = rightOffset

    return obj

def find_level(root, level):
    for l in root["levels"]:
        if (l["level"] == level):
            return l;

    return None;

def create_mobile(root):
    default_level = find_level(root, "default")
    uppercase_level = find_level(root, "shift")
    optkeys_level = find_level(root, "opt")
    optshiftkeys_level = find_level(root, "opt+shift")

    default_level_second_last_row = default_level["rows"][len(default_level["rows"]) - 2]
    default_level_last_row = default_level["rows"][len(default_level["rows"]) - 1]

    if len(default_level["rows"][0]) == 12: # Thai, Lao, Khmer
        pass
    elif len(default_level["rows"][0]) == 11:
        pass
    elif len(default_level["rows"][0]) == 10:
        pass
    else:
        raise KeyError("Found %d cols in first row: %s" %(len(default_level["rows"][0]), root["name"]))

    if len(default_level["rows"][1]) == 12: # Thai, Lao, Khmer
        pass
    elif len(default_level["rows"][1]) == 11:
        pass
    elif len(default_level["rows"][1]) == 10:
        pass
    elif len(default_level["rows"][1]) == 9:
        default_level["rows"][1][0]["leftOffset"] = 0.5
        default_level["rows"][1][8]["rightOffset"] = 0.5
    else:
        raise KeyError("Found %d keys in second row: %s" %(len(default_level["rows"][1]), root["name"]))

    if len(default_level["rows"]) == 5: # Thai, Armenian, Lao, Khmer
        if len(default_level["rows"][2]) == 12: # Thai, Lao, Khmer
            pass
        elif len(default_level["rows"][2]) == 10: # Armenian
            pass
        else:
            raise KeyError("Found %d keys in third row: %s" %(len(default_level["rows"][2]), root["name"]))
    elif len(default_level["rows"]) == 4:
        pass
    else:
        raise KeyError("Found %d rows: %s" %(len(default_level["rows"]), root["name"]))

    if (uppercase_level):
        if len(default_level_second_last_row) == 9: # Macedonian, Kirghiz, Russian, Belarusian, Serbian, Ukrainian, Mongolian
            default_level_second_last_row.insert(0, create_action_key(action="levelSwitch", level="shift", iconName="osk-shift-symbolic", width=1))
            default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1))
        elif len(default_level_second_last_row) == 8: # Bulgarian
            default_level_second_last_row.insert(0, create_action_key(action="levelSwitch", level="shift", iconName="osk-shift-symbolic", width=1.5))
            default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.5))
        elif len(default_level_second_last_row) == 7:
            default_level_second_last_row.insert(0, create_action_key(action="levelSwitch", level="shift", iconName="osk-shift-symbolic", width=1.5))
            default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.5))
        else:
            raise KeyError("Found %d keys in second last row with uppercase level: %s" %(len(default_level_second_last_row), root["name"]))
    else:
        if len(default_level_second_last_row) == 10: # Thai, Persian, Arabic, Lao, Khmer
            if len(default_level["rows"][1]) == 12: # Thai, Lao, Khmer
                default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.75, leftOffset=0.25))
            elif len(default_level["rows"][1]) == 11: # Persian, Arabic
                default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic"))
            else:
                raise KeyError("Found %d keys in second row without uppercase level: %s" %(len(default_level["rows"][1]), root["name"]))
        elif len(default_level_second_last_row) == 9: # Hindi, Hebrew
            if len(default_level["rows"][1]) == 11: # Hindi
                default_level_second_last_row[0]["leftOffset"] = 1
                default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic"))
            elif len(default_level["rows"][1]) == 10: # Hebrew
                default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1))
            else:
                raise KeyError("Found %d keys in second row without uppercase level: %s" %(len(default_level["rows"][1]), root["name"]))

        elif len(default_level_second_last_row) == 7: # Georgian
            default_level_second_last_row[0]["leftOffset"] = 1.5
            default_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.25, leftOffset=0.25))
        else:
            raise KeyError("Found %d keys in second last row without uppercase level: %s" %(len(default_level_second_last_row), root["name"]))


    default_level_last_row.insert(0, create_action_key(action="levelSwitch", level="opt", label="123", width=1.5))
    default_level_last_row.insert(1, create_action_key(action="emoji", iconName="smile-symbolic"))
    default_level_last_row[3] = create_char_key(strings=[" "], width=3)
    default_level_last_row.append(create_action_key(action="languageMenu", iconName="osk-layout-symbolic"))
    default_level_last_row.append(create_char_key(keyval="0xff0d", iconName="osk-enter-symbolic", width=1.5))

    if (uppercase_level):
        uppercase_level_second_last_row = uppercase_level["rows"][len(uppercase_level["rows"]) - 2]
        uppercase_level_last_row = uppercase_level["rows"][len(uppercase_level["rows"]) - 1]

        if len(uppercase_level["rows"][0]) == 11:
            pass
        elif len(uppercase_level["rows"][0]) == 10:
            pass
        else:
            raise KeyError("Found %d keys in uppercase level first row: %s" %(len(default_level["rows"][0]), root["name"]))

        if len(uppercase_level["rows"][1]) == 11:
            pass
        elif len(uppercase_level["rows"][1]) == 10:
            pass
        elif len(uppercase_level["rows"][1]) == 9:
            uppercase_level["rows"][1][0]["leftOffset"] = 0.5
            uppercase_level["rows"][1][8]["rightOffset"] = 0.5
        else:
            raise KeyError("Found %d keys in uppercase level second row: %s" %(len(default_level["rows"][1]), root["name"]))

        if len(uppercase_level_second_last_row) == 9: # Macedonian, Kirghiz, Russian, Belarusian, Serbian, Ukrainian, Mongolian
            uppercase_level_second_last_row.insert(0, create_action_key(action="levelSwitch", level="default", iconName="osk-shift-symbolic", width=1))
            uppercase_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1))
        elif len(uppercase_level_second_last_row) == 8: # Bulgarian
            uppercase_level_second_last_row.insert(0, create_action_key(action="levelSwitch", level="default", iconName="osk-shift-symbolic", width=1.5))
            uppercase_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.5))
        elif len(uppercase_level_second_last_row) == 7:
            uppercase_level_second_last_row.insert(0, create_action_key(action="levelSwitch", level="default", iconName="osk-shift-symbolic", width=1.5))
            uppercase_level_second_last_row.append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.5))
        else:
            raise KeyError("Found %d keys in uppercase level second last row: %s" %(len(uppercase_level_second_last_row), root["name"]))

        uppercase_level_last_row.insert(0, create_action_key(action="levelSwitch", level="opt", label="123", width=1.5))
        uppercase_level_last_row.insert(1, create_action_key(action="emoji", iconName="smile-symbolic"))
        uppercase_level_last_row[3] = create_char_key(strings=[" "], width=3)
        uppercase_level_last_row.append(create_action_key(action="languageMenu", iconName="osk-layout-symbolic"))
        uppercase_level_last_row.append(create_char_key(keyval="0xff0d", iconName="osk-enter-symbolic", width=1.5))

    optkeys_level["rows"][2].insert(0, create_action_key(action="levelSwitch", level="opt+shift", label="=/<", width=1.5))
    optkeys_level["rows"][2].append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.5))

    # Remove ° so that - in opt can be _ in opt+shift
    degree_key = optshiftkeys_level["rows"][1][5];
    optshiftkeys_level["rows"][1][5] = optkeys_level["rows"][3].pop(0)

    # Move / to last free entry in 2nd row
    optkeys_level["rows"][1].append(optkeys_level["rows"][3].pop(0))

    optkeys_level["rows"][3].insert(0, create_action_key(action="levelSwitch", level="default", label="ABC", width=1.5))
    optkeys_level["rows"][3].insert(1, create_action_key(action="emoji", iconName="smile-symbolic"))
    optkeys_level["rows"][3].pop(2)
    optkeys_level["rows"][3].insert(3, create_char_key(strings=[" "], width=3))
    optkeys_level["rows"][3].append(create_action_key(action="languageMenu", iconName="osk-layout-symbolic"))
    optkeys_level["rows"][3].append(create_char_key(keyval="0xff0d", iconName="osk-enter-symbolic", width=1.5))

    # Move \ to last free entry in 2nd row
    optshiftkeys_level["rows"][1].append(optshiftkeys_level["rows"][2].pop(0))

    optshiftkeys_level["rows"][2].insert(0, degree_key);
    optshiftkeys_level["rows"][2].insert(0, create_action_key(action="levelSwitch", level="opt", label="123", width=1.5))
    optshiftkeys_level["rows"][2].append(create_action_key(action="delete", iconName="osk-delete-symbolic", width=1.5))

    optshiftkeys_level["rows"][3].pop(3)
    optshiftkeys_level["rows"][3].pop(3)
    optshiftkeys_level["rows"][3].insert(0, create_action_key(action="levelSwitch", level="default", label="ABC", width=1.5))
    optshiftkeys_level["rows"][3].insert(1, create_action_key(action="emoji", iconName="smile-symbolic"))
    optshiftkeys_level["rows"][3].pop(4)
    optshiftkeys_level["rows"][3].insert(3, create_char_key(strings=[" "], width=3))
    optshiftkeys_level["rows"][3].append(create_action_key(action="languageMenu", iconName="osk-layout-symbolic"))
    optshiftkeys_level["rows"][3].append(create_char_key(keyval="0xff0d", iconName="osk-enter-symbolic", width=1.5))

    return root

def create_mobile_terminal(mobile_root):
    terminal_row = []
    terminal_row.append(create_char_key(keyval="0xff09", label="Tab", width=2, height=0.75))
    terminal_row.append(create_modifier_key(keyval="0xffe3", label="Ctrl", width=2, height=0.75))
    terminal_row.append(create_modifier_key(keyval="0xffe9", label="Alt", width=2, height=0.75))
    terminal_row.append(create_char_key(keyval="0xff52", iconName="go-up-symbolic", height=0.75))
    terminal_row.append(create_char_key(keyval="0xff54", iconName="go-down-symbolic", height=0.75))
    terminal_row.append(create_char_key(keyval="0xff51", iconName="go-previous-symbolic", height=0.75))
    terminal_row.append(create_char_key(keyval="0xff53", iconName="go-next-symbolic", height=0.75))

    for level in mobile_root["levels"]:
        level["rows"].insert(0, terminal_row)

    return mobile_root

def convert_file(source_file, destination_path):
    logging.info("Parsing %s", source_file)

    itree = xml.etree.ElementTree.ElementTree()
    itree.parse(source_file)

    root = convert_xml(itree)

    try:
        xkb_name = locale_to_xkb(root["locale"], root["name"])
    except KeyError as e:
        logging.warning(e)
        return False
    destination_file = os.path.join(destination_path, xkb_name + ".json")

    try:
        with open(destination_file, 'x', encoding="utf-8") as dest_fd:
            json.dump(root, dest_fd, ensure_ascii=False, indent=2, sort_keys=True)
    except FileExistsError as e:
        logging.info("File %s exists, not updating", destination_file)

    logging.debug("written %s", destination_file)

    mobile_root = create_mobile(root)

    try:
        xkb_name = locale_to_xkb(root["locale"], root["name"])
    except KeyError as e:
        logging.warning(e)
        return False
    destination_file = os.path.join(destination_path, xkb_name + "-mobile.json")

    try:
        with open(destination_file, 'x', encoding="utf-8") as dest_fd:
            json.dump(mobile_root, dest_fd, ensure_ascii=False, indent=2, sort_keys=True)
    except FileExistsError as e:
        logging.info("File %s exists, not updating", destination_file)

    logging.debug("written %s", destination_file)

    mobile_terminal_root = create_mobile_terminal(mobile_root)

    try:
        xkb_name = locale_to_xkb(root["locale"], root["name"])
    except KeyError as e:
        logging.warning(e)
        return False
    destination_file = os.path.join(destination_path, xkb_name + "-extended-mobile.json")

    try:
        with open(destination_file, 'x', encoding="utf-8") as dest_fd:
            json.dump(mobile_terminal_root, dest_fd, ensure_ascii=False, indent=2, sort_keys=True)
    except FileExistsError as e:
        logging.info("File %s exists, not updating", destination_file)
        return False

    logging.debug("written %s", destination_file)


def load_xkb_mappings():
    xkb = GnomeDesktop.XkbInfo()
    layouts = xkb.get_all_layouts()
    name_to_xkb = {}

    for layout in layouts:
        name = xkb.get_layout_info(layout).display_name
        name_to_xkb[name] = layout

    return name_to_xkb


locale.setlocale(locale.LC_ALL, "C")
name_to_xkb = load_xkb_mappings()


if __name__ == "__main__":
    if "DEBUG" in os.environ:
        logging.basicConfig(level=logging.DEBUG)

    if len(sys.argv) < 2:
        print("supply a CLDR keyboard file")
        sys.exit(1)

    if len(sys.argv) < 3:
        print("supply an output directory")
        sys.exit(1)

    source = sys.argv[1]
    destination = sys.argv[2]
    if os.path.isfile(source):
        convert_file(source, destination)
    elif os.path.isdir(source):
        for path in glob.glob(source + "/*-t-k0-android.xml"):
            convert_file(path, destination)
