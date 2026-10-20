// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//go:build windows

package acl

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// OwnerOnly replaces the DACL of a file or folder with a single entry
// granting the current user full control, and turns off inheritance from
// the parent. On a folder the entry is inherited by everything created in
// it later.
func OwnerOnly(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	sid, err := currentUser()
	if err != nil {
		return err
	}
	inherit := uint32(windows.NO_INHERITANCE)
	if fi.IsDir() {
		inherit = windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       inherit,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}}, nil)
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, acl, nil)
}

func currentUser() (*windows.SID, error) {
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return tu.User.Sid, nil
}

// Check returns nil if path is private the way OwnerOnly leaves it: the
// DACL is protected from inheritance and every entry allows the current
// user only. (On a folder Windows stores OwnerOnly's one inheritable entry
// as two: one for the folder itself and one inherit-only entry for its
// contents.) Tests use it.
func Check(path string) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	ctl, _, err := sd.Control()
	if err != nil {
		return err
	}
	if ctl&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("DACL inheritance is not disabled")
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return fmt.Errorf("no DACL: %v", err)
	}
	if dacl.AceCount == 0 {
		return errors.New("empty DACL")
	}
	me, err := currentUser()
	if err != nil {
		return err
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return fmt.Errorf("ACE %d type %d is not allow", i, ace.Header.AceType)
		}
		if sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)); !sid.Equals(me) {
			return fmt.Errorf("ACE %d SID %s is not the current user %s", i, sid, me)
		}
	}
	return nil
}
