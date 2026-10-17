"""Install the decoded distribution profile and prepare manual Xcode export."""

from datetime import datetime, timezone
from fnmatch import fnmatchcase
import os
from pathlib import Path
import plistlib
import shutil
import uuid


def prepare_profile():
    runner_temp = Path(os.environ["RUNNER_TEMP"])
    profile = plistlib.loads((runner_temp / "pathos-profile.plist").read_bytes())
    bundle_id = "com.swsoftworks.pathos"
    method = os.environ["IOS_EXPORT_METHOD"]
    if method not in {"app-store-connect", "release-testing"}:
        raise ValueError("Unsupported IPA export method.")

    entitlements = profile["Entitlements"]
    app_pattern = entitlements["application-identifier"].split(".", 1)[1]
    if not fnmatchcase(bundle_id, app_pattern):
        raise ValueError(f"The provisioning profile does not cover {bundle_id}.")
    if entitlements.get("get-task-allow"):
        raise ValueError("Use an Apple Distribution profile, not a development profile.")
    has_devices = bool(profile.get("ProvisionedDevices"))
    if profile.get("ProvisionsAllDevices") or has_devices != (method == "release-testing"):
        raise ValueError("Use an App Store profile for app-store-connect or an Ad Hoc profile for release-testing.")
    if profile["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise ValueError("The provisioning profile has expired.")

    profile_uuid = str(uuid.UUID(profile["UUID"])).upper()
    team_id = profile["TeamIdentifier"][0]
    if not team_id.isascii() or not team_id.isalnum():
        raise ValueError("Invalid Apple team identifier.")

    profiles_dir = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    profiles_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(runner_temp / "pathos.mobileprovision", profiles_dir / f"{profile_uuid}.mobileprovision")

    export_path = Path("build/ios/export-options.plist")
    export_path.parent.mkdir(parents=True, exist_ok=True)
    export_path.write_bytes(plistlib.dumps({
        "method": method,
        "signingStyle": "manual",
        "teamID": team_id,
        "signingCertificate": "Apple Distribution",
        "provisioningProfiles": {bundle_id: profile_uuid},
        "manageAppVersionAndBuildNumber": False,
    }))
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as environment:
        environment.write(f"IOS_TEAM_ID={team_id}\nIOS_PROFILE_UUID={profile_uuid}\n")
    print(f"Prepared {method} signing for {bundle_id}.")


if __name__ == "__main__":
    prepare_profile()
